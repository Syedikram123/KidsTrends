// KID'S TRENDS POS - INDEXEDDB DATABASE WRAPPER

const DB_NAME = 'KidsTrendsDB';
const DB_VERSION = 1;

let dbInstance = null;

/**
 * Initializes and returns the IndexedDB instance.
 */
function initDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Settings store (PIN hash, store metadata, bill sequence number)
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }

            // Products store (Key: code)
            if (!db.objectStoreNames.contains('products')) {
                const productStore = db.createObjectStore('products', { keyPath: 'code' });
                productStore.createIndex('name', 'name', { unique: false });
                productStore.createIndex('category', 'category', { unique: false });
            }

            // Bills store (Key: id, e.g. KT00001)
            if (!db.objectStoreNames.contains('bills')) {
                const billStore = db.createObjectStore('bills', { keyPath: 'id' });
                billStore.createIndex('dateTimestamp', 'dateTimestamp', { unique: false });
            }

            // Deleted Bills store (Key: id)
            if (!db.objectStoreNames.contains('deleted_bills')) {
                db.createObjectStore('deleted_bills', { keyPath: 'id' });
            }

            // Audit Logs store (Key: id, autoIncrement)
            if (!db.objectStoreNames.contains('audit_logs')) {
                db.createObjectStore('audit_logs', { keyPath: 'id', autoIncrement: true });
            }
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            resolve(dbInstance);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

/**
 * Helper to get an object store in a transaction.
 */
async function getStore(storeName, mode = 'readonly') {
    const db = await initDB();
    const transaction = db.transaction(storeName, mode);
    return transaction.objectStore(storeName);
}

// ==========================================
// SETTINGS OPERATIONS
// ==========================================

async function getSetting(key, defaultValue = null) {
    const store = await getStore('settings', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => {
            resolve(request.result ? request.result.value : defaultValue);
        };
        request.onerror = () => reject(request.error);
    });
}

async function setSetting(key, value) {
    const store = await getStore('settings', 'readwrite');
    return new Promise((resolve, reject) => {
        const request = store.put({ key, value });
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
    });
}

// ==========================================
// AUDIT LOGS OPERATIONS
// ==========================================

async function logActivity(action, details = '') {
    try {
        const db = await initDB();
        const transaction = db.transaction('audit_logs', 'readwrite');
        const store = transaction.objectStore('audit_logs');
        const log = {
            timestamp: new Date().toISOString(),
            action,
            details
        };
        store.add(log);
    } catch (e) {
        console.error('Audit log failed:', e);
    }
}

async function getAuditLogs() {
    const store = await getStore('audit_logs', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            // Sort by latest first
            const logs = request.result || [];
            logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            resolve(logs);
        };
        request.onerror = () => reject(request.error);
    });
}

// ==========================================
// PRODUCT OPERATIONS
// ==========================================

async function getAllProducts() {
    const store = await getStore('products', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function getProduct(code) {
    const store = await getStore('products', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.get(code);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Saves a product. We read existing first, then start write transaction
 * to avoid yielding during the active write transaction.
 */
async function saveProduct(product) {
    const existing = await getProduct(product.code);
    const now = new Date().toISOString();
    
    const finalProduct = {
        ...product,
        price: parseFloat(product.price) || 0,
        stock: parseInt(product.stock) || 0,
        createdDate: existing ? existing.createdDate : now,
        updatedDate: now
    };

    const store = await getStore('products', 'readwrite');
    return new Promise((resolve, reject) => {
        const request = store.put(finalProduct);
        request.onsuccess = () => {
            const action = existing ? 'Product Updated' : 'Product Added';
            logActivity(action, `${product.code} - ${product.name} (Qty: ${product.stock}, Price: ${product.price})`);
            resolve(true);
        };
        request.onerror = () => reject(request.error);
    });
}

async function deleteProduct(code) {
    const product = await getProduct(code);
    if (!product) return false;

    const store = await getStore('products', 'readwrite');
    return new Promise((resolve, reject) => {
        const request = store.delete(code);
        request.onsuccess = () => {
            logActivity('Product Deleted', `${code} - ${product.name}`);
            resolve(true);
        };
        request.onerror = () => reject(request.error);
    });
}

// ==========================================
// BILLING & TRANSACTION MANAGEMENT
// ==========================================

/**
 * Creates a new bill in a single atomic transaction.
 * Deducts stock from products.
 * Uses request chaining to avoid microtask yields during transaction.
 */
async function createBill(cartItems, discountInfo, gstPercent) {
    const db = await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['settings', 'products', 'bills', 'audit_logs'], 'readwrite');
        
        transaction.onerror = () => {
            reject(transaction.error || new Error('Transaction failed'));
        };

        const settingsStore = transaction.objectStore('settings');
        const productsStore = transaction.objectStore('products');
        const billsStore = transaction.objectStore('bills');
        const logsStore = transaction.objectStore('audit_logs');

        // 1. Fetch sequence number
        const lastSeqRequest = settingsStore.get('last_bill_sequence');
        
        lastSeqRequest.onsuccess = () => {
            let sequence = lastSeqRequest.result ? lastSeqRequest.result.value : 0;
            const nextSequence = sequence + 1;
            const billId = `KT${String(nextSequence).padStart(5, '0')}`;

            // 2. Schedule all product get requests synchronously
            const gets = cartItems.map(item => ({
                item,
                request: productsStore.get(item.code)
            }));

            let completedCount = 0;
            const productsToUpdate = [];

            gets.forEach(g => {
                g.request.onsuccess = () => {
                    const dbProduct = g.request.result;
                    if (!dbProduct) {
                        transaction.abort();
                        reject(new Error(`Product not found: ${g.item.name} (${g.item.code})`));
                        return;
                    }
                    if (dbProduct.stock < g.item.qty) {
                        transaction.abort();
                        reject(new Error(`OUT OF STOCK: ${dbProduct.name} has only ${dbProduct.stock} units left.`));
                        return;
                    }

                    // Prepare stock deduction
                    dbProduct.stock -= g.item.qty;
                    dbProduct.updatedDate = new Date().toISOString();
                    productsToUpdate.push(dbProduct);

                    completedCount++;
                    
                    // Once all product stock gets are finished and verified
                    if (completedCount === gets.length) {
                        // 3. Write stock updates
                        productsToUpdate.forEach(p => productsStore.put(p));

                        // 4. Calculate pricing totals
                        const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
                        
                        let discountAmount = 0;
                        if (discountInfo.type === 'percentage') {
                            discountAmount = Math.round((subtotal * (discountInfo.value / 100)) * 100) / 100;
                        } else if (discountInfo.type === 'fixed') {
                            discountAmount = Math.min(discountInfo.value, subtotal);
                        }

                        const taxableAmount = subtotal - discountAmount;
                        const gstAmount = gstPercent > 0 ? Math.round((taxableAmount * (gstPercent / 100)) * 100) / 100 : 0;
                        const grandTotal = Math.round((taxableAmount + gstAmount) * 100) / 100;

                        const now = new Date();
                        const dateStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
                        
                        let hours = now.getHours();
                        const minutes = String(now.getMinutes()).padStart(2, '0');
                        const ampm = hours >= 12 ? 'PM' : 'AM';
                        hours = hours % 12;
                        hours = hours ? hours : 12;
                        const timeStr = `${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;

                        const billRecord = {
                            id: billId,
                            date: dateStr,
                            time: timeStr,
                            dateTimestamp: now.getTime(),
                            items: cartItems.map(item => ({
                                code: item.code,
                                name: item.name,
                                price: item.price,
                                qty: item.qty,
                                total: item.price * item.qty
                            })),
                            subtotal,
                            discountType: discountInfo.type,
                            discountValue: discountInfo.value,
                            discountAmount,
                            gstPercent,
                            gstAmount,
                            grandTotal
                        };

                        // 5. Save settings counter & insert bill record
                        settingsStore.put({ key: 'last_bill_sequence', value: nextSequence });
                        billsStore.add(billRecord);

                        // 6. Write to Audit Log
                        logsStore.add({
                            timestamp: now.toISOString(),
                            action: 'Bill Generated',
                            details: `${billId} - Total: ₹${grandTotal} (Items: ${cartItems.length})`
                        });

                        // 7. Resolve when transaction completes writing
                        transaction.oncomplete = () => {
                            resolve(billRecord);
                        };
                    }
                };

                g.request.onerror = () => {
                    transaction.abort();
                    reject(g.request.error);
                };
            });
        };

        lastSeqRequest.onerror = () => {
            transaction.abort();
            reject(lastSeqRequest.error);
        };
    });
}

/**
 * Returns all bills.
 */
async function getAllBills() {
    const store = await getStore('bills', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            // Sort by latest timestamp first
            const bills = request.result || [];
            bills.sort((a, b) => b.dateTimestamp - a.dateTimestamp);
            resolve(bills);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Fetches a single bill by ID.
 */
async function getBill(id) {
    const store = await getStore('bills', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Deletes a bill and RESTORES product stocks.
 * Uses request chaining to avoid microtask yields.
 */
async function deleteBill(billId, reason) {
    const db = await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['products', 'bills', 'deleted_bills', 'audit_logs'], 'readwrite');

        transaction.onerror = () => {
            reject(transaction.error || new Error('Delete bill transaction failed'));
        };

        const productsStore = transaction.objectStore('products');
        const billsStore = transaction.objectStore('bills');
        const deletedStore = transaction.objectStore('deleted_bills');
        const logsStore = transaction.objectStore('audit_logs');

        // 1. Get the bill record
        const billReq = billsStore.get(billId);
        
        billReq.onsuccess = () => {
            const bill = billReq.result;
            if (!bill) {
                transaction.abort();
                reject(new Error('Bill not found'));
                return;
            }

            // 2. Schedule product fetches synchronously
            const gets = bill.items.map(item => ({
                item,
                request: productsStore.get(item.code)
            }));

            let completedCount = 0;
            const productsToRestore = [];

            gets.forEach(g => {
                g.request.onsuccess = () => {
                    const product = g.request.result;
                    if (product) {
                        product.stock += g.item.qty;
                        product.updatedDate = new Date().toISOString();
                        productsToRestore.push(product);
                    }

                    completedCount++;
                    
                    if (completedCount === gets.length) {
                        // All product stock records retrieved. Write updates back.
                        productsToRestore.forEach(p => productsStore.put(p));

                        // Move bill to deleted_bills
                        const deletedRecord = {
                            ...bill,
                            deletedTimestamp: new Date().toISOString(),
                            deletionReason: reason || 'N/A'
                        };
                        deletedStore.add(deletedRecord);

                        // Delete from active bills
                        billsStore.delete(billId);

                        // Add audit log
                        logsStore.add({
                            timestamp: new Date().toISOString(),
                            action: 'Bill Deleted',
                            details: `${billId} - Reason: ${reason} (Restored stock)`
                        });

                        transaction.oncomplete = () => {
                            resolve(true);
                        };
                    }
                };

                g.request.onerror = () => {
                    transaction.abort();
                    reject(g.request.error);
                };
            });
        };

        billReq.onerror = () => {
            transaction.abort();
            reject(billReq.error);
        };
    });
}

async function getDeletedBills() {
    const store = await getStore('deleted_bills', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            const list = request.result || [];
            list.sort((a, b) => new Date(b.deletedTimestamp) - new Date(a.deletedTimestamp));
            resolve(list);
        };
        request.onerror = () => reject(request.error);
    });
}

// ==========================================
// DATA BACKUP & RESTORE
// ==========================================

/**
 * Exports all database stores. Schedules read requests synchronously.
 */
async function exportBackupJSON() {
    const db = await initDB();
    const stores = ['settings', 'products', 'bills', 'deleted_bills', 'audit_logs'];
    const backupData = {};

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(stores, 'readonly');
        transaction.onerror = () => reject(transaction.error);

        let completed = 0;
        stores.forEach(storeName => {
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => {
                backupData[storeName] = request.result;
                completed++;
                if (completed === stores.length) {
                    resolve(JSON.stringify(backupData, null, 2));
                }
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    });
}

async function restoreBackupJSON(jsonDataString) {
    let backupData;
    try {
        backupData = JSON.parse(jsonDataString);
    } catch (e) {
        throw new Error('Invalid JSON format');
    }

    const stores = ['settings', 'products', 'bills', 'deleted_bills', 'audit_logs'];
    for (const store of stores) {
        if (!Array.isArray(backupData[store])) {
            throw new Error(`Missing or invalid store in backup: ${store}`);
        }
    }

    const db = await initDB();
    const transaction = db.transaction(stores, 'readwrite');

    return new Promise((resolve, reject) => {
        transaction.onerror = () => reject(transaction.error || new Error('Restore transaction failed'));
        transaction.oncomplete = () => {
            logActivity('Database Restored', 'System restored from file backup');
            resolve(true);
        };

        try {
            for (const storeName of stores) {
                const store = transaction.objectStore(storeName);
                
                // Clear existing records first
                store.clear();
                
                // Import records
                for (const item of backupData[storeName]) {
                    store.put(item);
                }
            }
        } catch (e) {
            transaction.abort();
            reject(e);
        }
    });
}

// Initialize seed data if products are empty
async function seedDefaultProducts() {
    const products = await getAllProducts();
    if (products.length === 0) {
        const defaults = [
            { code: '101', name: 'Cotton T-Shirt', category: 'Kids Wear', price: 250, stock: 45 },
            { code: '102', name: 'Denim Jeans', category: 'Kids Wear', price: 650, stock: 25 },
            { code: '103', name: 'Kurta Pyjama Set', category: 'Ethnic Wear', price: 799, stock: 15 },
            { code: '104', name: 'Designer Frock', category: 'Girls Wear', price: 950, stock: 20 },
            { code: '105', name: 'Baby Romper 3-Pack', category: 'Infants', price: 499, stock: 35 },
            { code: '106', name: 'Cotton Cap', category: 'Accessories', price: 120, stock: 50 },
            { code: '107', name: 'Socks Pack of 3', category: 'Accessories', price: 150, stock: 60 }
        ];
        for (const p of defaults) {
            await saveProduct(p);
        }
        console.log('Seeded database with default product list.');
    }
}
