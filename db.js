// KID'S TRENDS POS - INDEXEDDB DATABASE WRAPPER

const DB_NAME = 'KidsTrendsDB';
const DB_VERSION = 2;

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

            // Rollback backups store (for safety restore rollback)
            if (!db.objectStoreNames.contains('rollback_backups')) {
                db.createObjectStore('rollback_backups', { keyPath: 'id' });
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
async function createBill(cartItems, discountInfo, paymentMode, customerMobile, cashier) {
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
                                paymentMode: paymentMode || 'Cash',
                                paymentMethod: paymentMode || 'Cash',
                                cashAmount: (paymentMode === 'Cash') ? grandTotal : 0,
                                upiAmount: (paymentMode === 'UPI') ? grandTotal : 0,
                                customerMobile: customerMobile || '',
                                cashier: cashier || 'Irfan',
                                createdAt: now.toISOString(),
                                updatedAt: null,
                                editCount: 0,
                                editHistory: []
                            };

                            // Save original and current copies
                            billRecord.originalBill = {
                                id: billId,
                                date: dateStr,
                                time: timeStr,
                                dateTimestamp: billRecord.dateTimestamp,
                                items: JSON.parse(JSON.stringify(billRecord.items)),
                                subtotal,
                                discountType: discountInfo.type,
                                discountValue: discountInfo.value,
                                discountAmount,
                                gstPercent: 0,
                                gstAmount: 0,
                                grandTotal,
                                paymentMode: billRecord.paymentMode,
                                paymentMethod: billRecord.paymentMethod,
                                cashAmount: billRecord.cashAmount,
                                upiAmount: billRecord.upiAmount,
                                customerMobile: billRecord.customerMobile,
                                cashier: billRecord.cashier
                            };
                            billRecord.currentBill = {
                                id: billId,
                                date: dateStr,
                                time: timeStr,
                                dateTimestamp: billRecord.dateTimestamp,
                                items: JSON.parse(JSON.stringify(billRecord.items)),
                                subtotal,
                                discountType: discountInfo.type,
                                discountValue: discountInfo.value,
                                discountAmount,
                                gstPercent: 0,
                                gstAmount: 0,
                                grandTotal,
                                paymentMode: billRecord.paymentMode,
                                paymentMethod: billRecord.paymentMethod,
                                cashAmount: billRecord.cashAmount,
                                upiAmount: billRecord.upiAmount,
                                customerMobile: billRecord.customerMobile,
                                cashier: billRecord.cashier
                            };

                            // 5. Save settings counters
                            settingsStore.put({ key: 'last_bill_date', value: dateKey });
                            settingsStore.put({ key: 'last_bill_sequence', value: nextSeq });
                            
                            // Save bill record
                            sanitizeBillForStorage(billRecord);
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
 * Sanitizes a bill object before storing it in IndexedDB by removing any temporary
 * receipt image/canvas/base64/html properties to optimize storage size.
 */
function sanitizeBillForStorage(bill) {
    if (!bill) return bill;
    const keysToDelete = [
        'receipt', 'receiptpng', 'receiptimage', 'receiptcanvas', 
        'base64', 'base64image', 'receipthtml', 'renderedreceipt',
        'image', 'canvas', 'png', 'html'
    ];
    
    const cleanObject = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
            const lowerKey = key.toLowerCase();
            if (keysToDelete.some(k => lowerKey.includes(k))) {
                delete obj[key];
            } else if (typeof obj[key] === 'object') {
                cleanObject(obj[key]);
            }
        }
    };
    
    cleanObject(bill);
    return bill;
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
 * Updates an existing bill with a customer mobile number.
 */
async function updateBillMobile(billId, mobile) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('bills', 'readwrite');
        const store = transaction.objectStore('bills');
        
        const req = store.get(billId);
        req.onsuccess = () => {
            const bill = req.result;
            if (bill) {
                bill.customerMobile = mobile;
                sanitizeBillForStorage(bill);
                const putReq = store.put(bill);
                putReq.onsuccess = () => resolve(true);
                putReq.onerror = () => reject(putReq.error);
            } else {
                reject(new Error("Bill not found"));
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Updates an existing bill. Calculates exchangeDifference, saves to editHistory,
 * updates inventory stock using the difference between old bill and new bill,
 * and updates cashAmount, upiAmount, currentBill, editCount and updatedAt.
 */
async function updateBill(billId, newCartItems, discountInfo, paymentMode, customerMobile, cashier) {
    const db = await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['products', 'bills', 'audit_logs'], 'readwrite');
        
        transaction.onerror = () => {
            reject(transaction.error || new Error('Update bill transaction failed'));
        };

        const productsStore = transaction.objectStore('products');
        const billsStore = transaction.objectStore('bills');
        const logsStore = transaction.objectStore('audit_logs');

        const billReq = billsStore.get(billId);
        
        billReq.onsuccess = () => {
            let bill = billReq.result;
            if (!bill) {
                transaction.abort();
                reject(new Error(`Bill ${billId} not found`));
                return;
            }
            
            bill = sanitizeBill(bill);
            
            const oldTotal = bill.grandTotal;
            const oldItems = bill.items || [];
            
            // Compute difference for stock adjustments: oldQty - newQty
            const itemKeys = new Set();
            oldItems.forEach(i => itemKeys.add(`${i.code}|${i.size}`));
            newCartItems.forEach(i => itemKeys.add(`${i.code}|${i.size}`));
            
            const diffs = [];
            itemKeys.forEach(key => {
                const [code, size] = key.split('|');
                const oldItem = oldItems.find(i => i.code === code && i.size === size);
                const newItem = newCartItems.find(i => i.code === code && i.size === size);
                const oldQty = oldItem ? oldItem.qty : 0;
                const newQty = newItem ? newItem.qty : 0;
                const diffQty = oldQty - newQty; // Positive = restock, Negative = deduct
                
                if (diffQty !== 0) {
                    diffs.push({ code, size, diffQty });
                }
            });
            
            const gets = diffs.map(d => ({
                diff: d,
                request: productsStore.get(d.code)
            }));
            
            let completedCount = 0;
            const productsToUpdate = [];
            
            if (gets.length === 0) {
                saveUpdatedBillDetails();
                return;
            }
            
            gets.forEach(g => {
                g.request.onsuccess = () => {
                    let product = g.request.result;
                    if (!product) {
                        transaction.abort();
                        reject(new Error(`Product not found: ${g.diff.code}`));
                        return;
                    }
                    
                    product = sanitizeProduct(product);
                    const sizeObj = product.sizes.find(s => s.size === String(g.diff.size).trim());
                    if (!sizeObj) {
                        transaction.abort();
                        reject(new Error(`Size '${g.diff.size}' not found for product '${product.name}'`));
                        return;
                    }
                    
                    if (sizeObj.stock + g.diff.diffQty < 0) {
                        transaction.abort();
                        reject(new Error(`OUT OF STOCK: ${product.name} (Size: ${g.diff.size}) has only ${sizeObj.stock} units left. Cannot deduct ${Math.abs(g.diff.diffQty)} more.`));
                        return;
                    }
                    
                    sizeObj.stock += g.diff.diffQty;
                    product.updatedDate = new Date().toISOString();
                    
                    const existingInUpdate = productsToUpdate.find(p => p.code === product.code);
                    if (!existingInUpdate) {
                        productsToUpdate.push(product);
                    }
                    
                    completedCount++;
                    if (completedCount === gets.length) {
                        productsToUpdate.forEach(p => productsStore.put(p));
                        saveUpdatedBillDetails();
                    }
                };
                
                g.request.onerror = () => {
                    transaction.abort();
                    reject(g.request.error);
                };
            });
            
            function saveUpdatedBillDetails() {
                const subtotal = newCartItems.reduce((sum, item) => sum + (item.price * item.qty), 0);
                
                let discountAmount = 0;
                if (discountInfo.type === 'percentage') {
                    discountAmount = Math.round((subtotal * (discountInfo.value / 100)) * 100) / 100;
                } else if (discountInfo.type === 'fixed') {
                    discountAmount = Math.min(discountInfo.value, subtotal);
                }
                
                const grandTotal = Math.round((subtotal - discountAmount) * 100) / 100;
                const now = new Date();
                
                const diff = grandTotal - oldTotal;
                
                // History Entry represents the transition from this state to the next
                const historyEntry = {
                    version: bill.editHistory ? bill.editHistory.length + 1 : 1,
                    updatedAt: now.toISOString(),
                    action: 'edit',
                    exchangeDifference: diff,
                    items: JSON.parse(JSON.stringify(oldItems)),
                    subtotal: bill.subtotal,
                    discountType: bill.discountType,
                    discountValue: bill.discountValue,
                    discountAmount: bill.discountAmount,
                    grandTotal: bill.grandTotal,
                    paymentMode: bill.paymentMode,
                    paymentMethod: bill.paymentMethod || bill.paymentMode,
                    cashAmount: bill.cashAmount !== undefined ? bill.cashAmount : (bill.paymentMode === 'Cash' ? bill.grandTotal : 0),
                    upiAmount: bill.upiAmount !== undefined ? bill.upiAmount : (bill.paymentMode === 'UPI' ? bill.grandTotal : 0),
                    customerMobile: bill.customerMobile,
                    cashier: bill.cashier
                };
                
                // Store originalBill snapshot if not already present
                if (!bill.originalBill) {
                    bill.originalBill = JSON.parse(JSON.stringify(historyEntry));
                    // Keep originalBill clean of version history fields
                    delete bill.originalBill.version;
                    delete bill.originalBill.updatedAt;
                    delete bill.originalBill.action;
                    delete bill.originalBill.exchangeDifference;
                }
                
                bill.editHistory = bill.editHistory || [];
                bill.editHistory.push(historyEntry);
                
                bill.editCount = (bill.editCount || 0) + 1;
                bill.updatedAt = now.toISOString();
                
                // Update current fields
                bill.items = newCartItems.map(item => ({
                    code: item.code,
                    name: item.name,
                    size: item.size,
                    price: item.price,
                    qty: item.qty,
                    total: item.price * item.qty
                }));
                bill.subtotal = subtotal;
                bill.discountType = discountInfo.type;
                bill.discountValue = discountInfo.value;
                bill.discountAmount = discountAmount;
                bill.grandTotal = grandTotal;
                bill.paymentMode = paymentMode || 'Cash';
                bill.paymentMethod = paymentMode || 'Cash';
                bill.cashAmount = (paymentMode === 'Cash') ? grandTotal : 0;
                bill.upiAmount = (paymentMode === 'UPI') ? grandTotal : 0;
                bill.customerMobile = customerMobile || '';
                bill.cashier = cashier || 'Irfan';
                
                bill.currentBill = {
                    id: bill.id,
                    date: bill.date,
                    time: bill.time,
                    dateTimestamp: bill.dateTimestamp,
                    items: JSON.parse(JSON.stringify(bill.items)),
                    subtotal,
                    discountType: discountInfo.type,
                    discountValue: discountInfo.value,
                    discountAmount,
                    gstPercent: 0,
                    gstAmount: 0,
                    grandTotal,
                    paymentMode: bill.paymentMode,
                    paymentMethod: bill.paymentMethod,
                    cashAmount: bill.cashAmount,
                    upiAmount: bill.upiAmount,
                    customerMobile: bill.customerMobile,
                    cashier: bill.cashier
                };
                
                sanitizeBillForStorage(bill);
                billsStore.put(bill);
                
                logsStore.add({
                    timestamp: now.toISOString(),
                    action: 'Bill Updated',
                    details: `${billId} - Edited from ₹${oldTotal} to ₹${grandTotal} (Edit #${bill.editCount})`
                });
                
                transaction.oncomplete = () => {
                    resolve(bill);
                };
            }
        };
        
        billReq.onerror = () => {
            transaction.abort();
            reject(billReq.error);
        };
    });
}

/**
 * Restores a bill to its original creation state. Appends a restore action to editHistory,
 * increments editCount, and reverts stock adjustments.
 */
async function restoreBillToOriginal(billId) {
    const db = await initDB();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['products', 'bills', 'audit_logs'], 'readwrite');
        
        transaction.onerror = () => {
            reject(transaction.error || new Error('Restore bill transaction failed'));
        };

        const productsStore = transaction.objectStore('products');
        const billsStore = transaction.objectStore('bills');
        const logsStore = transaction.objectStore('audit_logs');

        const billReq = billsStore.get(billId);
        
        billReq.onsuccess = () => {
            let bill = billReq.result;
            if (!bill) {
                transaction.abort();
                reject(new Error(`Bill ${billId} not found`));
                return;
            }
            
            bill = sanitizeBill(bill);
            
            if (!bill.originalBill) {
                transaction.abort();
                reject(new Error('This bill has never been edited and is already in its original state.'));
                return;
            }
            
            const currentItems = bill.items || [];
            const originalItems = bill.originalBill.items || [];
            
            // Stock differences to restore: currentQty - originalQty
            const itemKeys = new Set();
            currentItems.forEach(i => itemKeys.add(`${i.code}|${i.size}`));
            originalItems.forEach(i => itemKeys.add(`${i.code}|${i.size}`));
            
            const diffs = [];
            itemKeys.forEach(key => {
                const [code, size] = key.split('|');
                const currItem = currentItems.find(i => i.code === code && i.size === size);
                const origItem = originalItems.find(i => i.code === code && i.size === size);
                const currQty = currItem ? currItem.qty : 0;
                const origQty = origItem ? origItem.qty : 0;
                const diffQty = currQty - origQty; // Positive = add back, Negative = deduct
                
                if (diffQty !== 0) {
                    diffs.push({ code, size, diffQty });
                }
            });
            
            const gets = diffs.map(d => ({
                diff: d,
                request: productsStore.get(d.code)
            }));
            
            let completedCount = 0;
            const productsToUpdate = [];
            
            if (gets.length === 0) {
                restoreBillData();
                return;
            }
            
            gets.forEach(g => {
                g.request.onsuccess = () => {
                    let product = g.request.result;
                    if (!product) {
                        transaction.abort();
                        reject(new Error(`Product not found: ${g.diff.code}`));
                        return;
                    }
                    
                    product = sanitizeProduct(product);
                    const sizeObj = product.sizes.find(s => s.size === String(g.diff.size).trim());
                    if (!sizeObj) {
                        transaction.abort();
                        reject(new Error(`Size '${g.diff.size}' not found for product '${product.name}'`));
                        return;
                    }
                    
                    if (sizeObj.stock + g.diff.diffQty < 0) {
                        transaction.abort();
                        reject(new Error(`OUT OF STOCK: Reverting would cause product ${product.name} (Size: ${g.diff.size}) to go out of stock. Available inventory is ${sizeObj.stock} but need to deduct ${Math.abs(g.diff.diffQty)}.`));
                        return;
                    }
                    
                    sizeObj.stock += g.diff.diffQty;
                    product.updatedDate = new Date().toISOString();
                    
                    const existingInUpdate = productsToUpdate.find(p => p.code === product.code);
                    if (!existingInUpdate) {
                        productsToUpdate.push(product);
                    }
                    
                    completedCount++;
                    if (completedCount === gets.length) {
                        productsToUpdate.forEach(p => productsStore.put(p));
                        restoreBillData();
                    }
                };
                
                g.request.onerror = () => {
                    transaction.abort();
                    reject(g.request.error);
                };
            });
            
            function restoreBillData() {
                const now = new Date();
                const orig = bill.originalBill;
                const diff = orig.grandTotal - bill.grandTotal; // naturally balances the exchange amount
                
                const historyEntry = {
                    version: bill.editHistory ? bill.editHistory.length + 1 : 1,
                    updatedAt: now.toISOString(),
                    action: 'restore',
                    exchangeDifference: diff,
                    items: JSON.parse(JSON.stringify(bill.items)),
                    subtotal: bill.subtotal,
                    discountType: bill.discountType,
                    discountValue: bill.discountValue,
                    discountAmount: bill.discountAmount,
                    grandTotal: bill.grandTotal,
                    paymentMode: bill.paymentMode,
                    paymentMethod: bill.paymentMethod || bill.paymentMode,
                    cashAmount: bill.cashAmount,
                    upiAmount: bill.upiAmount,
                    customerMobile: bill.customerMobile,
                    cashier: bill.cashier
                };
                
                bill.editHistory = bill.editHistory || [];
                bill.editHistory.push(historyEntry);
                
                bill.editCount = (bill.editCount || 0) + 1;
                bill.updatedAt = now.toISOString();
                
                // Revert fields to original values
                bill.items = JSON.parse(JSON.stringify(orig.items));
                bill.subtotal = orig.subtotal;
                bill.discountType = orig.discountType;
                bill.discountValue = orig.discountValue;
                bill.discountAmount = orig.discountAmount;
                bill.grandTotal = orig.grandTotal;
                bill.paymentMode = orig.paymentMode;
                bill.paymentMethod = orig.paymentMethod || orig.paymentMode;
                bill.cashAmount = orig.cashAmount !== undefined ? orig.cashAmount : (orig.paymentMode === 'Cash' ? orig.grandTotal : 0);
                bill.upiAmount = orig.upiAmount !== undefined ? orig.upiAmount : (orig.paymentMode === 'UPI' ? orig.grandTotal : 0);
                bill.customerMobile = orig.customerMobile;
                bill.cashier = orig.cashier;
                
                bill.currentBill = {
                    id: bill.id,
                    date: bill.date,
                    time: orig.time,
                    dateTimestamp: orig.dateTimestamp,
                    items: JSON.parse(JSON.stringify(bill.items)),
                    subtotal: bill.subtotal,
                    discountType: bill.discountType,
                    discountValue: bill.discountValue,
                    discountAmount: bill.discountAmount,
                    gstPercent: 0,
                    gstAmount: 0,
                    grandTotal: bill.grandTotal,
                    paymentMode: bill.paymentMode,
                    paymentMethod: bill.paymentMethod,
                    cashAmount: bill.cashAmount,
                    upiAmount: bill.upiAmount,
                    customerMobile: bill.customerMobile,
                    cashier: bill.cashier
                };
                
                sanitizeBillForStorage(bill);
                billsStore.put(bill);
                
                logsStore.add({
                    timestamp: now.toISOString(),
                    action: 'Bill Restored to Original',
                    details: `${billId} - Reverted back to original total of ₹${orig.grandTotal}`
                });
                
                transaction.oncomplete = () => {
                    resolve(bill);
                };
            }
        };
        
        billReq.onerror = () => {
            transaction.abort();
            reject(billReq.error);
        };
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
                        sanitizeBillForStorage(deletedRecord);
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
    // Exclude rollback_backups from stores to back up
    const stores = Array.from(db.objectStoreNames).filter(s => s !== 'rollback_backups');
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
                    // Include localStorage contents dynamically, excluding cloud and auth metadata
                    const localStoreData = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        const isExcluded = key.startsWith('sb-') || 
                                           key.startsWith('supabase.') ||
                                           key === 'kids_trends_cloud_backups' ||
                                           key === 'kids_trends_cloud_last_upload' ||
                                           key === 'kids_trends_restore_undo';
                        if (!isExcluded) {
                            localStoreData[key] = localStorage.getItem(key);
                        }
                    }
                    backupData['__localStorage__'] = localStoreData;
                    
                    const wrappedData = {
                        metadata: {
                            backupVersion: "1.0",
                            createdAt: new Date().toISOString(),
                            appVersion: "1.0.0",
                            databaseVersion: DB_VERSION
                        },
                        data: backupData
                    };
                    
                    resolve(JSON.stringify(wrappedData, null, 2));
                }
            };
            request.onerror = () => {
                reject(request.error);
            };
        });
    });
}

async function restoreBackupJSON(jsonDataString) {
    let parsed;
    try {
        parsed = JSON.parse(jsonDataString);
    } catch (e) {
        throw new Error('Invalid JSON format');
    }

    let backupData;
    let metadata = null;
    if (parsed && parsed.metadata && parsed.data) {
        backupData = parsed.data;
        metadata = parsed.metadata;
    } else {
        // Legacy backup format
        backupData = parsed;
    }

    if (!backupData) {
        throw new Error('Backup contains no data.');
    }

    const db = await initDB();
    const stores = Array.from(db.objectStoreNames);
    
    // Ensure we can clear/restore all object stores present in backup that exist in DB (excluding rollback_backups)
    const storesToRestore = stores.filter(s => s !== 'rollback_backups' && Array.isArray(backupData[s]));
    if (storesToRestore.length === 0) {
        throw new Error('Backup contains no valid database stores.');
    }

    const transaction = db.transaction(storesToRestore, 'readwrite');

    return new Promise((resolve, reject) => {
        transaction.onerror = () => reject(transaction.error || new Error('Restore transaction failed'));
        transaction.oncomplete = () => {
            // Restore localStorage contents dynamically if present
            if (backupData['__localStorage__']) {
                const localStoreData = backupData['__localStorage__'];
                for (const key of Object.keys(localStoreData)) {
                    localStorage.setItem(key, localStoreData[key]);
                }
            }
            logActivity('Database Restored', 'System restored from file backup');
            resolve(true);
        };

        try {
            for (const storeName of storesToRestore) {
                const store = transaction.objectStore(storeName);
                store.clear();
                for (const item of backupData[storeName]) {
                    if (storeName === 'bills' || storeName === 'deleted_bills') {
                        sanitizeBillForStorage(item);
                    }
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

// Rollback backup operations in IndexedDB
async function saveRollbackBackup(jsonStr) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['rollback_backups'], 'readwrite');
        const store = transaction.objectStore('rollback_backups');
        const request = store.put({ id: 'latest_rollback', content: jsonStr, createdAt: new Date().toISOString() });
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(transaction.error || request.error);
    });
}

async function getRollbackBackup() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['rollback_backups'], 'readonly');
        const store = transaction.objectStore('rollback_backups');
        const request = store.get('latest_rollback');
        request.onsuccess = () => resolve(request.result ? request.result.content : null);
        request.onerror = () => reject(transaction.error || request.error);
    });
}

async function clearRollbackBackup() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['rollback_backups'], 'readwrite');
        const store = transaction.objectStore('rollback_backups');
        const request = store.delete('latest_rollback');
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(transaction.error || request.error);
    });
}

async function deleteAuditLog(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['audit_logs'], 'readwrite');
        const store = transaction.objectStore('audit_logs');
        const request = store.delete(id);
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(transaction.error || request.error);
    });
}
