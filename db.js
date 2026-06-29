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

            // Settings store (PIN hash, store details, sequential numbers)
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }

            // Products store (Key: code)
            if (!db.objectStoreNames.contains('products')) {
                const productStore = db.createObjectStore('products', { keyPath: 'code' });
                productStore.createIndex('name', 'name', { unique: false });
                productStore.createIndex('category', 'category', { unique: false });
            }

            // Bills store (Key: id)
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

/**
 * Sanitizes a product object to ensure it has a valid sizes array.
 * Migrates legacy products (Phase 1) with root-level price/stock to new schema.
 */
function sanitizeProduct(p) {
    if (!p) return null;
    if (!p.sizes || !Array.isArray(p.sizes)) {
        p.sizes = [];
        // Legacy products had root level price and stock
        if (p.price !== undefined && p.stock !== undefined) {
            p.sizes.push({
                size: 'Standard',
                price: parseFloat(p.price) || 0,
                stock: parseInt(p.stock) || 0
            });
        }
    }
    return p;
}

async function getAllProducts() {
    const store = await getStore('products', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            const list = request.result || [];
            list.forEach(p => sanitizeProduct(p));
            resolve(list);
        };
        request.onerror = () => reject(request.error);
    });
}

async function getProduct(code) {
    const store = await getStore('products', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.get(code);
        request.onsuccess = () => {
            const p = request.result;
            resolve(p ? sanitizeProduct(p) : null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Saves a product record.
 */
async function saveProduct(product) {
    const existing = await getProduct(product.code);
    const now = new Date().toISOString();
    
    const finalProduct = {
        ...product,
        sizes: (product.sizes || []).map(s => ({
            size: String(s.size).trim(),
            price: parseFloat(s.price) || 0,
            stock: parseInt(s.stock) || 0
        })),
        createdDate: existing ? existing.createdDate : now,
        updatedDate: now
    };

    const store = await getStore('products', 'readwrite');
    return new Promise((resolve, reject) => {
        const request = store.put(finalProduct);
        request.onsuccess = () => {
            const action = existing ? 'Product Updated' : 'Product Added';
            logActivity(action, `${product.code} - ${product.name} (Sizes Count: ${finalProduct.sizes.length})`);
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
 * Deducts stock from specific sizes of products.
 * Uses request chaining to avoid microtask yields.
 */
async function createBill(cartItems, discountInfo, paymentMode) {
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

        // Calculate today's date prefix: DDMMYY (local timezone)
        const now = new Date();
        const DD = String(now.getDate()).padStart(2, '0');
        const MM = String(now.getMonth() + 1).padStart(2, '0');
        const YY = String(now.getFullYear()).slice(-2);
        const dateKey = `${DD}${MM}${YY}`;

        // 1. Fetch sequence number and last billing date in parallel
        const dateReq = settingsStore.get('last_bill_date');
        const seqReq = settingsStore.get('last_bill_sequence');
        
        let dateResult = null;
        let seqResult = null;
        let readsCompleted = 0;

        const onReadComplete = () => {
            readsCompleted++;
            if (readsCompleted === 2) {
                const lastDate = dateReq.result ? dateReq.result.value : null;
                let sequence = seqReq.result ? seqReq.result.value : 0;
                
                let nextSeq = 1;
                if (lastDate === dateKey) {
                    nextSeq = sequence + 1;
                }
                
                const billId = `${dateKey}${String(nextSeq).padStart(2, '0')}`;

                // 2. Schedule all product get requests synchronously to check stock
                const gets = cartItems.map(item => ({
                    item,
                    request: productsStore.get(item.code)
                }));

                let completedCount = 0;
                const productsToUpdate = [];

                gets.forEach(g => {
                    g.request.onsuccess = () => {
                        let dbProduct = g.request.result;
                        if (!dbProduct) {
                            transaction.abort();
                            reject(new Error(`Product not found: ${g.item.name} (${g.item.code})`));
                            return;
                        }

                        // Ensure product object has valid sizes array (sanitize)
                        dbProduct = sanitizeProduct(dbProduct);

                        // Locate size object
                        const sizeObj = dbProduct.sizes.find(s => s.size === String(g.item.size).trim());
                        if (!sizeObj) {
                            transaction.abort();
                            reject(new Error(`Size '${g.item.size}' not found for product '${dbProduct.name}'`));
                            return;
                        }

                        if (sizeObj.stock < g.item.qty) {
                            transaction.abort();
                            reject(new Error(`OUT OF STOCK: ${dbProduct.name} (Size: ${g.item.size}) has only ${sizeObj.stock} units left.`));
                            return;
                        }

                        // Prepare stock deduction
                        sizeObj.stock -= g.item.qty;
                        dbProduct.updatedDate = new Date().toISOString();
                        
                        const existingInUpdate = productsToUpdate.find(p => p.code === dbProduct.code);
                        if (!existingInUpdate) {
                            productsToUpdate.push(dbProduct);
                        }

                        completedCount++;
                        
                        if (completedCount === gets.length) {
                            // 3. Write product updates back to database
                            productsToUpdate.forEach(p => productsStore.put(p));

                            // 4. Calculate pricing totals
                            const subtotal = cartItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
                            
                            let discountAmount = 0;
                            if (discountInfo.type === 'percentage') {
                                discountAmount = Math.round((subtotal * (discountInfo.value / 100)) * 100) / 100;
                            } else if (discountInfo.type === 'fixed') {
                                discountAmount = Math.min(discountInfo.value, subtotal);
                            }

                            const grandTotal = Math.round((subtotal - discountAmount) * 100) / 100;

                            const dateStr = `${DD}-${MM}-${now.getFullYear()}`;
                            
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
                                    size: item.size,
                                    price: item.price,
                                    qty: item.qty,
                                    total: item.price * item.qty
                                })),
                                subtotal,
                                discountType: discountInfo.type,
                                discountValue: discountInfo.value,
                                discountAmount,
                                gstPercent: 0,
                                gstAmount: 0,
                                grandTotal,
                                paymentMode: paymentMode || 'Cash'
                            };

                            // 5. Save settings counters
                            settingsStore.put({ key: 'last_bill_date', value: dateKey });
                            settingsStore.put({ key: 'last_bill_sequence', value: nextSeq });
                            
                            // Save bill record
                            billsStore.add(billRecord);

                            // 6. Write to Audit Log
                            logsStore.add({
                                timestamp: now.toISOString(),
                                action: 'Bill Generated',
                                details: `${billId} - Total: ₹${grandTotal} (Mode: ${paymentMode})`
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
            }
        };

        dateReq.onsuccess = onReadComplete;
        seqReq.onsuccess = onReadComplete;
        
        dateReq.onerror = () => { transaction.abort(); reject(dateReq.error); };
        seqReq.onerror = () => { transaction.abort(); reject(seqReq.error); };
    });
}

/**
 * Sanitizes a bill object to make sure its items array exists.
 */
function sanitizeBill(b) {
    if (!b) return null;
    if (!b.items || !Array.isArray(b.items)) {
        b.items = [];
    }
    return b;
}

/**
 * Returns all bills.
 */
async function getAllBills() {
    const store = await getStore('bills', 'readonly');
    return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
            const bills = request.result || [];
            bills.forEach(b => sanitizeBill(b));
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
        request.onsuccess = () => {
            const b = request.result;
            resolve(b ? sanitizeBill(b) : null);
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Deletes a bill and RESTORES product stock sizes.
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
            let bill = billReq.result;
            if (!bill) {
                transaction.abort();
                reject(new Error('Bill not found'));
                return;
            }

            bill = sanitizeBill(bill);

            // 2. Schedule product fetches synchronously to restore stock sizes
            const gets = bill.items.map(item => ({
                item,
                request: productsStore.get(item.code)
            }));

            let completedCount = 0;
            const productsToRestore = [];

            gets.forEach(g => {
                g.request.onsuccess = () => {
                    let product = g.request.result;
                    if (product) {
                        product = sanitizeProduct(product);
                        const sizeObj = product.sizes.find(s => s.size === String(g.item.size).trim());
                        if (sizeObj) {
                            sizeObj.stock += g.item.qty;
                        }
                        product.updatedDate = new Date().toISOString();
                        
                        const existingInRestore = productsToRestore.find(p => p.code === product.code);
                        if (!existingInRestore) {
                            productsToRestore.push(product);
                        }
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
            list.forEach(b => sanitizeBill(b));
            list.sort((a, b) => new Date(b.deletedTimestamp) - new Date(a.deletedTimestamp));
            resolve(list);
        };
        request.onerror = () => reject(request.error);
    });
}

// ==========================================
// DATA BACKUP & RESTORE
// ==========================================

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
                store.clear();
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

// Seeding default products is disabled for clean slate
async function seedDefaultProducts() {
    // Disabled as requested. Starts with a clean inventory.
}
