// KID'S TRENDS POS - APPLICATION LOGIC (PHASE 2 - ROBUST VERSION)

// ==========================================
// STATE MANAGEMENT
// ==========================================
const state = {
    cart: [],
    discountType: 'percentage', // 'percentage' | 'fixed'
    discountValue: 0,
    paymentMode: 'Cash',        // 'Cash' | 'UPI'
    cashier: 'Irfan',           // Default selected cashier
    currentSection: 'home',
    adminUnlocked: false,
    adminTab: 'analytics',
    pendingAdminTab: null,      // Tracks target tab when prompting password
    allProducts: [],
    searchResults: [],
    activeBill: null,
    editingBillId: null,        // Tracks the bill ID currently being edited
    backupDirty: true,          // Tracks if DB backup needs regeneration
    cachedBackupJSON: null,     // Holds cached backup JSON string
    cachedBackupSize: 0,        // Holds cached backup size in bytes
    cachedBackupHash: null      // Holds cached database SHA-256 hash string
};

// Default hashed password for "1234"
const DEFAULT_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

let supabaseClient = null;

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Initialize Supabase Client & Background Auth
        if (typeof supabase !== 'undefined' && typeof SUPABASE_CONFIG !== 'undefined') {
            try {
                supabaseClient = supabase.createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY);
                const { data, error } = await supabaseClient.auth.signInWithPassword({
                    email: SUPABASE_CONFIG.AUTH_EMAIL,
                    password: SUPABASE_CONFIG.AUTH_PASSWORD
                });
                if (error) {
                    console.error('Supabase authentication failed:', error.message);
                } else {
                    console.log('Supabase authenticated successfully. Session active.');
                }
            } catch (supaErr) {
                console.error('Error setting up Supabase client:', supaErr);
            }
        } else {
            console.warn('Supabase JS SDK or SUPABASE_CONFIG is missing.');
        }

        // Initialize IndexedDB
        await initDB();
        
        // Ensure default PIN/Password is seeded in Settings (overwriting legacy ABCD1234 default hash)
        const storedPinHash = await getSetting('admin_pin_hash');
        if (!storedPinHash || storedPinHash === '1635c8525afbae58c37bede3c9440844e9143727cc7c160bed665ec378d8a262') {
            await setSetting('admin_pin_hash', DEFAULT_PIN_HASH);
        }

        // Ensure default Cloud Backup Password is seeded in Settings
        const storedCloudHash = await getSetting('cloud_backup_pin_hash');
        if (!storedCloudHash) {
            await setSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);
        }
        
        // Load products cache (<50ms target)
        await refreshProductsCache();

        // Initial database cache generation (pre-computes initial JSON and hash)
        try {
            await getOrGenerateLocalBackup();
        } catch (e) {
            console.error('Failed to generate initial database cache:', e);
        }
        
        // Initialize UI event handlers
        setupEventListeners();
        switchSection('home');
        
    } catch (err) {
        console.error('Failed to initialize application:', err);
        showToast('Database Error: ' + err.message, 'error');
    }
});

/**
 * Refreshes the memory cache of products for super fast searching.
 */
async function refreshProductsCache() {
    state.allProducts = await getAllProducts() || [];
    // Update Home dashboard and inventory widgets
    await updateHomeDashboard();
    // Mark backup dirty when products or transactions change
    markBackupDirty();
}

// ==========================================
// ROUTING, SECTIONS & ADMIN TABS
// ==========================================
function switchSection(sectionId) {
    state.currentSection = sectionId;
    
    // Toggle active class on views
    (document.querySelectorAll('.view-section') || []).forEach(section => {
        section.classList.remove('active');
    });
    
    const targetSection = document.getElementById(`${sectionId}-section`);
    if (targetSection) {
        targetSection.classList.add('active');
    }

    // Toggle navigation highlight
    (document.querySelectorAll('.nav-item') || []).forEach(item => {
        item.classList.remove('active');
    });
    const targetNavItem = document.getElementById(`nav-${sectionId}`);
    if (targetNavItem) {
        targetNavItem.classList.add('active');
    }

    // Tab-specific actions
    if (sectionId === 'home') {
        updateHomeDashboard();
    } else if (sectionId === 'bill') {
        renderCart();
    } else if (sectionId === 'admin') {
        renderAdminView();
    }
}

/**
 * Handles Quick Actions click on Home screen.
 * Forces admin password authentication if locked.
 */
function handleAdminQuickAction(targetTab) {
    if (state.adminUnlocked) {
        state.adminTab = targetTab;
        switchSection('admin');
    } else {
        state.pendingAdminTab = targetTab;
        switchSection('admin');
    }
}

function renderAdminView() {
    const adminContent = document.getElementById('admin-content');
    const adminLogin = document.getElementById('admin-login');

    if (state.adminUnlocked) {
        adminLogin.style.display = 'none';
        adminContent.style.display = 'block';
        
        if (state.pendingAdminTab) {
            state.adminTab = state.pendingAdminTab;
            state.pendingAdminTab = null;
        }
        switchAdminTab(state.adminTab);
    } else {
        adminLogin.style.display = 'flex';
        adminContent.style.display = 'none';
        
        const pwdInput = document.getElementById('admin-password-input');
        if (pwdInput) {
            pwdInput.value = '';
            setTimeout(() => pwdInput.focus(), 100);
        }
    }
}

function switchAdminTab(tabName) {
    state.adminTab = tabName;
    (document.querySelectorAll('.admin-tab-btn') || []).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    (document.querySelectorAll('.admin-tab-content') || []).forEach(content => {
        content.classList.toggle('active', content.id === `admin-tab-${tabName}`);
    });

    if (tabName === 'analytics') {
        loadAnalytics('today');
    } else if (tabName === 'inventory') {
        renderInventoryList();
    } else if (tabName === 'bills') {
        renderBillsList();
    } else if (tabName === 'settings') {
        loadSettingsTab();
    }
}

// ==========================================
// SEARCH & AUTOCOMPLETE (SIZE-BASED OPTIONS)
// ==========================================
function handleSearchInput(query) {
    const suggestionsBox = document.getElementById('search-suggestions');
    if (!query.trim()) {
        suggestionsBox.innerHTML = '';
        suggestionsBox.style.display = 'none';
        return;
    }

    const cleanQuery = query.toLowerCase();
    
    // Filter from local products cache (< 5ms)
    const matches = (state.allProducts || []).filter(p => 
        (p.code || '').toLowerCase().includes(cleanQuery) || 
        (p.name || '').toLowerCase().includes(cleanQuery) ||
        (p.category || '').toLowerCase().includes(cleanQuery)
    );

    if (matches.length === 0) {
        suggestionsBox.innerHTML = '<div class="suggestion-item no-match">No products found</div>';
        suggestionsBox.style.display = 'block';
        return;
    }

    // Unroll each size as a distinct selection to prevent confusion
    let suggestionsHtml = '';

    for (const p of matches) {
        const sizesList = p.sizes || [];
        for (const s of sizesList) {
            const fullName = `${p.name}-${s.size}`;
            
            suggestionsHtml += `
                <div class="suggestion-item" onclick="addProductToCart('${p.code}', '${s.size}')">
                    <div class="suggest-details">
                        <span class="suggest-name font-medium">${fullName}</span>
                        <span class="suggest-code">Code: ${p.code} | Stock: ${s.stock}</span>
                    </div>
                    <span class="suggest-price font-bold">₹${s.price}</span>
                </div>
            `;
        }
    }

    suggestionsBox.innerHTML = suggestionsHtml;
    suggestionsBox.style.display = 'block';
}

function addProductToCart(code, size) {
    const product = (state.allProducts || []).find(p => p.code === code);
    if (!product) {
        showToast('Product not found', 'error');
        return;
    }

    const sizesList = product.sizes || [];
    const sizeObj = sizesList.find(s => s.size === String(size).trim());
    if (!sizeObj) {
        showToast(`Size ${size} not found`, 'error');
        return;
    }

    if (sizeObj.stock <= 0) {
        showToast(`OUT OF STOCK: ${product.name} (Size: ${size})`, 'error');
        return;
    }

    const existing = (state.cart || []).find(item => item.code === code && item.size === size);
    if (existing) {
        if (existing.qty >= sizeObj.stock) {
            showToast(`Stock limit reached (${sizeObj.stock} units)`, 'warning');
            return;
        }
        existing.qty += 1;
    } else {
        state.cart.push({
            code: product.code,
            name: product.name,
            size: sizeObj.size,
            price: sizeObj.price,
            stock: sizeObj.stock,
            qty: 1
        });
    }

    document.getElementById('billing-search').value = '';
    document.getElementById('search-suggestions').style.display = 'none';
    
    renderCart();
    playBeepSound();
}

// ==========================================
// CART CONTROLS
// ==========================================
function updateQuantity(code, size, delta) {
    const item = (state.cart || []).find(i => i.code === code && i.size === size);
    if (!item) return;

    const newQty = item.qty + delta;
    if (newQty <= 0) {
        state.cart = (state.cart || []).filter(i => !(i.code === code && i.size === size));
    } else {
        if (newQty > item.stock) {
            showToast(`Only ${item.stock} units available in stock.`, 'warning');
            return;
        }
        item.qty = newQty;
    }
    renderCart();
}

function removeItemFromCart(code, size) {
    state.cart = (state.cart || []).filter(i => !(i.code === code && i.size === size));
    renderCart();
}

function renderCart() {
    const cartTbody = document.getElementById('cart-tbody');
    const checkoutBtn = document.getElementById('btn-checkout');

    if (!state.cart || state.cart.length === 0) {
        cartTbody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-cart-row">
                    <div class="empty-cart-message">
                        🛒 Cart is empty. Search products below or scan QR code.
                    </div>
                </td>
            </tr>
        `;
        checkoutBtn.disabled = true;
        updateTotalsDisplay(0, 0, 0, 0);
        return;
    }

    checkoutBtn.disabled = false;
    
    let subtotal = 0;
    cartTbody.innerHTML = (state.cart || []).map(item => {
        const itemTotal = item.price * item.qty;
        subtotal += itemTotal;
        return `
            <tr>
                <td>
                    <div class="cart-prod-title">${item.name}-${item.size}</div>
                    <div class="cart-prod-sub">${item.code}</div>
                </td>
                <td class="text-right">₹${item.price}</td>
                <td>
                    <div class="qty-control">
                        <button type="button" class="qty-btn" onclick="updateQuantity('${item.code}', '${item.size}', -1)">-</button>
                        <span class="qty-val">${item.qty}</span>
                        <button type="button" class="qty-btn" onclick="updateQuantity('${item.code}', '${item.size}', 1)">+</button>
                    </div>
                </td>
                <td class="text-right font-medium">₹${itemTotal}</td>
                <td class="text-center">
                    <button type="button" class="cart-remove-btn" onclick="removeItemFromCart('${item.code}', '${item.size}')">&times;</button>
                </td>
            </tr>
        `;
    }).join('');

    calculateCartTotals(subtotal);
}

function calculateCartTotals(subtotal) {
    let discountAmount = 0;
    if (state.discountType === 'percentage') {
        discountAmount = Math.round((subtotal * (state.discountValue / 100)) * 100) / 100;
    } else if (state.discountType === 'fixed') {
        discountAmount = Math.min(state.discountValue, subtotal);
    }

    const grandTotal = Math.round((subtotal - discountAmount) * 100) / 100;
    const itemsCount = (state.cart || []).reduce((sum, item) => sum + item.qty, 0);

    updateTotalsDisplay(itemsCount, subtotal, discountAmount, grandTotal);
}

function updateTotalsDisplay(itemsCount, subtotal, discount, grandTotal) {
    document.getElementById('summary-items').innerText = itemsCount;
    document.getElementById('summary-subtotal').innerText = `₹${subtotal.toFixed(2)}`;
    
    const discountRow = document.getElementById('summary-discount').parentElement;
    if (discount > 0) {
        discountRow.style.display = 'flex';
        document.getElementById('summary-discount').innerText = `₹${discount.toFixed(2)}`;
    } else {
        discountRow.style.display = 'none';
    }

    document.getElementById('summary-total').innerText = `₹${grandTotal.toFixed(2)}`;
}

// ==========================================
// CHECKOUT & RECEIPT ENGINE
// ==========================================
async function handleCheckout() {
    if (!state.cart || state.cart.length === 0) return;

    if (state.editingBillId) {
        document.getElementById('edit-confirm-modal').style.display = 'flex';
        return;
    }

    const checkoutBtn = document.getElementById('btn-checkout');
    checkoutBtn.disabled = true;
    checkoutBtn.innerText = 'Processing...';

    const mobileField = document.getElementById('customer-mobile');
    const customerMobile = mobileField ? mobileField.value.trim() : '';

    try {
        const billRecord = await createBill(state.cart, {
            type: state.discountType,
            value: state.discountValue
        }, state.paymentMode, customerMobile, state.cashier || 'Irfan');

        showToast(`Bill ${billRecord.id} generated successfully!`, 'success');
        
        await refreshProductsCache();
        
        state.cart = [];
        resetBillingInputs();
        showReceiptModal(billRecord);
        downloadBillImage(billRecord);
        
    } catch (err) {
        showToast(err.message, 'error');
        checkoutBtn.disabled = false;
        checkoutBtn.innerText = 'Proceed Checkout';
    }
}

function resetBillingInputs() {
    state.discountValue = 0;
    document.getElementById('billing-discount-value').value = 0;
    document.getElementById('billing-search').value = '';
    const mobileField = document.getElementById('customer-mobile');
    if (mobileField) mobileField.value = '';
    renderCart();
}

async function viewBillDetails(billId) {
    try {
        const bill = await getBill(billId);
        if (bill) {
            showReceiptModal(bill);
        } else {
            showToast('Bill not found', 'error');
        }
    } catch (e) {
        showToast('Error loading bill: ' + e.message, 'error');
    }
}

function showReceiptModal(bill) {
    state.activeBill = bill;
    state.activeBillSource = state.currentSection;
    
    // Generate receipt via canvas and convert to PNG data URL
    const canvas = generateReceiptCanvas(bill);
    const dataUrl = canvas.toDataURL('image/png');
    
    const receiptImageHtml = `<img src="${dataUrl}" alt="Receipt" style="width: 100%; height: auto; display: block; margin: 0 auto;" />`;

    document.getElementById('receipt-modal-body').innerHTML = receiptImageHtml;
    document.getElementById('receipt-print-area').innerHTML = receiptImageHtml;
    document.getElementById('receipt-modal').style.display = 'flex';
}

function closeReceiptModal() {
    document.getElementById('receipt-modal').style.display = 'none';
    document.getElementById('receipt-modal-body').innerHTML = '';
    document.getElementById('receipt-print-area').innerHTML = '';
    state.activeBill = null;
    if (state.activeBillSource) {
        switchSection(state.activeBillSource);
        state.activeBillSource = null;
    } else {
        switchSection('bill');
    }
}

function printActiveReceipt() {
    if (state.activeBill) {
        const canvas = generateReceiptCanvas(state.activeBill);
        const dataUrl = canvas.toDataURL('image/png');
        const receiptImageHtml = `<img src="${dataUrl}" alt="Receipt" style="width: 100%; height: auto; display: block; margin: 0 auto;" />`;
        document.getElementById('receipt-print-area').innerHTML = receiptImageHtml;
        window.print();
    }
}

// ==========================================
// HOME SCREEN METRICS & DASHBOARD
// ==========================================
async function updateHomeDashboard() {
    const bills = await getAllBills() || [];
    
    // Get today's local date
    const now = new Date();
    const todayStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

    // Filter today's sales
    const todayBills = (bills || []).filter(b => b.date === todayStr);

    let todayRevenue = 0;
    let todayItemsSold = 0;
    (todayBills || []).forEach(b => {
        todayRevenue += b.grandTotal;
        const bItems = b.items || [];
        (bItems || []).forEach(item => {
            todayItemsSold += item.qty;
        });
    });

    // Update main cards
    document.getElementById('stat-revenue').innerText = `₹${todayRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('stat-bills').innerText = todayBills.length;
    document.getElementById('stat-items').innerText = todayItemsSold;

    // Render Recent Bills (up to 5)
    const recentBillsList = document.getElementById('recent-transactions-list');
    if (bills.length === 0) {
        recentBillsList.innerHTML = '<div class="no-recent">No transactions logged yet.</div>';
    } else {
        recentBillsList.innerHTML = (bills || []).slice(0, 5).map(b => `
            <div class="transaction-item" onclick="viewBillDetails('${b.id}')">
                <div class="trans-details">
                    <div class="trans-id">${b.id}</div>
                    <div class="trans-meta">${b.time} | ${(b.items || []).length} items (${b.paymentMode})</div>
                </div>
                <div class="trans-amount">₹${b.grandTotal.toFixed(2)}</div>
            </div>
        `).join('');
    }

    // Compile and Render Inventory Health Insights (Available, Out of Stock, Low Stock, Fast Selling)
    updateInventoryHealthInsights(bills);
}

function updateInventoryHealthInsights(allBills) {
    let availableCount = 0;
    let outOfStockCount = 0;
    let lowStockCount = 0;

    // Process all products and their sizes
    (state.allProducts || []).forEach(p => {
        const sizesList = p.sizes || [];
        (sizesList || []).forEach(s => {
            availableCount += s.stock;
            if (s.stock === 0) {
                outOfStockCount++;
            } else if (s.stock <= 5) {
                lowStockCount++;
            }
        });
    });

    // Fast selling count (distinct size items sold in the last 30 days)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const recentBills = (allBills || []).filter(b => b.dateTimestamp >= thirtyDaysAgo);
    
    const salesMap = {};
    (recentBills || []).forEach(b => {
        const bItems = b.items || [];
        (bItems || []).forEach(item => {
            const key = `${item.code}-${item.size}`;
            salesMap[key] = (salesMap[key] || 0) + item.qty;
        });
    });
    
    const fastSellingCount = Object.keys(salesMap).length;

    // Write to Home Insights widgets
    document.getElementById('insight-available-val').innerText = availableCount;
    document.getElementById('insight-outofstock-val').innerText = outOfStockCount;
    document.getElementById('insight-lowstock-val').innerText = lowStockCount;
    document.getElementById('insight-fastselling-val').innerText = fastSellingCount;
}

// ==========================================
// HOME INSIGHTS DETAIL MODALS
// ==========================================
function openInsightsDetail(type) {
    const modal = document.getElementById('insights-modal');
    const title = document.getElementById('insights-modal-title');
    const head = document.getElementById('insights-table-head');
    const body = document.getElementById('insights-table-body');

    modal.style.display = 'flex';
    body.innerHTML = '';

    if (type === 'available') {
        title.innerText = 'Available Stock Inventory';
        head.innerHTML = `
            <tr>
                <th>Code</th>
                <th>Product</th>
                <th>Size</th>
                <th class="text-right">Price</th>
                <th class="text-center">Stock</th>
            </tr>
        `;
        
        const list = [];
        (state.allProducts || []).forEach(p => {
            const sizesList = p.sizes || [];
            (sizesList || []).forEach(s => {
                if (s.stock > 0) {
                    list.push({ code: p.code, name: p.name, size: s.size, price: s.price, stock: s.stock });
                }
            });
        });

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="5" class="text-center pad-y-md text-muted">No items currently in stock.</td></tr>';
        } else {
            body.innerHTML = (list || []).map(x => `
                <tr>
                    <td class="font-medium">${x.code}</td>
                    <td>${x.name}</td>
                    <td><span class="size-badge">${x.size}</span></td>
                    <td class="text-right">₹${x.price}</td>
                    <td class="text-center font-bold" style="color: var(--success);">${x.stock} units</td>
                </tr>
            `).join('');
        }

    } else if (type === 'outofstock') {
        title.innerText = 'Out Of Stock Alert';
        head.innerHTML = `
            <tr>
                <th>Code</th>
                <th>Product</th>
                <th>Size</th>
                <th class="text-right">Price</th>
                <th class="text-center">Stock</th>
            </tr>
        `;
        
        const list = [];
        (state.allProducts || []).forEach(p => {
            const sizesList = p.sizes || [];
            (sizesList || []).forEach(s => {
                if (s.stock === 0) {
                    list.push({ code: p.code, name: p.name, size: s.size, price: s.price, stock: s.stock });
                }
            });
        });

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="5" class="text-center pad-y-md text-muted">Excellent! No out of stock items.</td></tr>';
        } else {
            body.innerHTML = (list || []).map(x => `
                <tr class="stock-out-row">
                    <td class="font-medium">${x.code}</td>
                    <td>${x.name}</td>
                    <td><span class="size-badge">${x.size}</span></td>
                    <td class="text-right">₹${x.price}</td>
                    <td class="text-center font-bold" style="color: var(--danger);">0 units</td>
                </tr>
            `).join('');
        }

    } else if (type === 'lowstock') {
        title.innerText = 'Low Stock Warnings (<= 5)';
        head.innerHTML = `
            <tr>
                <th>Code</th>
                <th>Product</th>
                <th>Size</th>
                <th class="text-right">Price</th>
                <th class="text-center">Stock</th>
            </tr>
        `;
        
        const list = [];
        (state.allProducts || []).forEach(p => {
            const sizesList = p.sizes || [];
            (sizesList || []).forEach(s => {
                if (s.stock > 0 && s.stock <= 5) {
                    list.push({ code: p.code, name: p.name, size: s.size, price: s.price, stock: s.stock });
                }
            });
        });

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="5" class="text-center pad-y-md text-muted">All stocks are at healthy levels.</td></tr>';
        } else {
            body.innerHTML = (list || []).map(x => `
                <tr class="stock-low-row">
                    <td class="font-medium">${x.code}</td>
                    <td>${x.name}</td>
                    <td><span class="size-badge">${x.size}</span></td>
                    <td class="text-right">₹${x.price}</td>
                    <td class="text-center font-bold" style="color: var(--warning);">${x.stock} units</td>
                </tr>
            `).join('');
        }

    } else if (type === 'fastselling') {
        title.innerText = 'Fast Selling Items (Last 30 Days)';
        head.innerHTML = `
            <tr>
                <th class="text-center">Rank</th>
                <th>Product Name</th>
                <th>Size</th>
                <th class="text-center">Total Quantity Sold</th>
            </tr>
        `;

        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        
        getAllBills().then(allBills => {
            const recentBills = (allBills || []).filter(b => b.dateTimestamp >= thirtyDaysAgo);
            
            const salesMap = {};
            (recentBills || []).forEach(b => {
                const bItems = b.items || [];
                (bItems || []).forEach(item => {
                    const key = `${item.code}|${item.name}|${item.size}`;
                    salesMap[key] = (salesMap[key] || 0) + item.qty;
                });
            });

            const list = Object.keys(salesMap).map(k => {
                const parts = k.split('|');
                return { code: parts[0], name: parts[1], size: parts[2], qtySold: salesMap[k] };
            });

            list.sort((a, b) => b.qtySold - a.qtySold);

            if (list.length === 0) {
                body.innerHTML = '<tr><td colspan="4" class="text-center pad-y-md text-muted">No sales logged in the last 30 days.</td></tr>';
            } else {
                body.innerHTML = (list || []).slice(0, 10).map((x, index) => `
                    <tr>
                        <td class="text-center font-bold">${index + 1}</td>
                        <td>
                            <div class="font-medium">${x.name}</div>
                            <div class="text-sm text-muted">Code: ${x.code}</div>
                        </td>
                        <td><span class="size-badge">${x.size}</span></td>
                        <td class="text-center font-bold" style="color: var(--accent-primary);">${x.qtySold} units</td>
                    </tr>
                `).join('');
            }
        });
    }
}

function closeInsightsModal() {
    document.getElementById('insights-modal').style.display = 'none';
}

// ==========================================
// CAMERA QR SCANNER & SIZE SELECTION MODAL
// ==========================================
function openScannerOverlay() {
    const scannerModal = document.getElementById('scanner-modal');
    const video = document.getElementById('scanner-video');
    const warning = document.getElementById('scanner-support-warning');
    
    scannerModal.style.display = 'flex';
    
    if (!isBarcodeScannerSupported()) {
        warning.style.display = 'block';
    } else {
        warning.style.display = 'none';
        
        startScanner(video, (scannedCode) => {
            closeScannerOverlay();
            handleScannedCode(scannedCode);
        }, (err) => {
            console.error('Scanner error:', err);
            showToast('Camera error: ' + err.message, 'error');
            closeScannerOverlay();
        });
    }
}

function closeScannerOverlay() {
    const scannerModal = document.getElementById('scanner-modal');
    const video = document.getElementById('scanner-video');
    stopScanner(video);
    scannerModal.style.display = 'none';
}

function handleScannedCode(scannedCode) {
    const cleanCode = String(scannedCode).trim();
    if (!cleanCode) return;

    const hyphenIndex = cleanCode.indexOf('-');
    if (hyphenIndex !== -1) {
        const prodCode = cleanCode.substring(0, hyphenIndex).trim();
        const sizeVal = cleanCode.substring(hyphenIndex + 1).trim();
        addProductToCart(prodCode, sizeVal);
        return;
    }

    const product = (state.allProducts || []).find(p => p.code === cleanCode);
    if (!product) {
        showToast(`Product code ${cleanCode} not found in database`, 'error');
        return;
    }

    const sizesList = product.sizes || [];
    if (sizesList.length === 1) {
        addProductToCart(product.code, sizesList[0].size);
        return;
    }

    openSizeSelectModal(product);
}

function openSizeSelectModal(product) {
    const modal = document.getElementById('size-select-modal');
    document.getElementById('size-select-product-name').innerText = `Select size for ${product.name} (${product.code}):`;
    
    const container = document.getElementById('size-select-buttons-container');
    const sizesList = product.sizes || [];
    container.innerHTML = (sizesList || []).map(s => `
        <button type="button" class="btn-primary" style="height: 48px; text-transform: uppercase;" 
                onclick="addProductToCart('${product.code}', '${s.size}'); closeSizeSelectModal();">
            Size: ${s.size} &nbsp;&nbsp;|&nbsp;&nbsp; ₹${s.price} &nbsp;&nbsp; (Stock: ${s.stock})
        </button>
    `).join('');

    modal.style.display = 'flex';
}

function closeSizeSelectModal() {
    document.getElementById('size-select-modal').style.display = 'none';
}

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================
async function handleAdminLoginSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('admin-password-input');
    const password = input.value.trim();
    if (!password) return;

    try {
        const hash = await sha256(password);
        const storedHash = await getSetting('admin_pin_hash', DEFAULT_PIN_HASH);

        if (hash === storedHash) {
            state.adminUnlocked = true;
            showToast('Admin session unlocked', 'success');
            input.value = '';
            renderAdminView();
        } else {
            showToast('Invalid administrative password', 'error');
            input.value = '';
            input.focus();
        }
    } catch (e) {
        showToast('Authentication error: ' + e.message, 'error');
    }
}

function lockAdmin() {
    state.adminUnlocked = false;
    showToast('Admin logged out', 'info');
    renderAdminView();
}

// ==========================================
// ADMIN PASSWORD RECOVERY MODAL
// ==========================================
function openResetPasswordModal() {
    // Clear all inputs
    const recoveryInput = document.getElementById('reset-recovery-input');
    const newPassInput = document.getElementById('reset-new-password');
    const confirmPassInput = document.getElementById('reset-confirm-password');

    if (recoveryInput) recoveryInput.value = '';
    if (newPassInput) newPassInput.value = '';
    if (confirmPassInput) confirmPassInput.value = '';

    // Hide error messages
    const recoveryError = document.getElementById('reset-recovery-error');
    const passwordError = document.getElementById('reset-password-error');
    if (recoveryError) recoveryError.style.display = 'none';
    if (passwordError) passwordError.style.display = 'none';

    // Show step 1 and hide step 2
    const step1Form = document.getElementById('reset-step-1-form');
    const step2Form = document.getElementById('reset-step-2-form');
    if (step1Form) step1Form.style.display = 'grid';
    if (step2Form) step2Form.style.display = 'none';

    // Show modal overlay
    const modal = document.getElementById('reset-password-modal');
    if (modal) modal.style.display = 'flex';
    if (recoveryInput) recoveryInput.focus();
}

function closeResetPasswordModal() {
    // Clear all inputs and reset modal back to step 1 before closing
    const recoveryInput = document.getElementById('reset-recovery-input');
    const newPassInput = document.getElementById('reset-new-password');
    const confirmPassInput = document.getElementById('reset-confirm-password');

    if (recoveryInput) recoveryInput.value = '';
    if (newPassInput) newPassInput.value = '';
    if (confirmPassInput) confirmPassInput.value = '';

    const recoveryError = document.getElementById('reset-recovery-error');
    const passwordError = document.getElementById('reset-password-error');
    if (recoveryError) recoveryError.style.display = 'none';
    if (passwordError) passwordError.style.display = 'none';

    const step1Form = document.getElementById('reset-step-1-form');
    const step2Form = document.getElementById('reset-step-2-form');
    if (step1Form) step1Form.style.display = 'grid';
    if (step2Form) step2Form.style.display = 'none';

    const modal = document.getElementById('reset-password-modal');
    if (modal) modal.style.display = 'none';
}

function handleResetStep1Submit(event) {
    event.preventDefault();
    const recoveryInput = document.getElementById('reset-recovery-input');
    const errorDiv = document.getElementById('reset-recovery-error');
    
    if (errorDiv) errorDiv.style.display = 'none';

    if (recoveryInput && recoveryInput.value.trim() === 'Recover@1') {
        // Step 1 correct: replace with step 2
        const step1Form = document.getElementById('reset-step-1-form');
        const step2Form = document.getElementById('reset-step-2-form');
        if (step1Form) step1Form.style.display = 'none';
        if (step2Form) step2Form.style.display = 'grid';
        const newPassInput = document.getElementById('reset-new-password');
        if (newPassInput) newPassInput.focus();
    } else {
        // Incorrect recovery code: show error and do not continue
        if (errorDiv) errorDiv.style.display = 'block';
    }
}

async function handleResetStep2Submit(event) {
    event.preventDefault();
    const newPassInput = document.getElementById('reset-new-password');
    const confirmPassInput = document.getElementById('reset-confirm-password');
    const errorDiv = document.getElementById('reset-password-error');

    if (errorDiv) errorDiv.style.display = 'none';

    const newPass = newPassInput ? newPassInput.value.trim() : '';
    const confirmPass = confirmPassInput ? confirmPassInput.value.trim() : '';

    // Validate that both passwords match and are not empty
    if (!newPass || !confirmPass) {
        if (errorDiv) {
            errorDiv.innerText = 'Passwords cannot be empty.';
            errorDiv.style.display = 'block';
        }
        return;
    }

    if (newPass !== confirmPass) {
        if (errorDiv) {
            errorDiv.innerText = 'Passwords do not match.';
            errorDiv.style.display = 'block';
        }
        return;
    }

    try {
        // Save the new admin password using the same existing password storage method (sha256 and setSetting)
        const newHash = await sha256(newPass);
        await setSetting('admin_pin_hash', newHash);

        // Log the activity
        await logActivity('Admin Password Reset', 'Password reset using recovery code');

        // Show a success message
        showToast('Password updated successfully.', 'success');

        // Reset the modal back to Step 1 and clear all inputs, then close the modal
        closeResetPasswordModal();
    } catch (e) {
        if (errorDiv) {
            errorDiv.innerText = 'Failed to reset password: ' + e.message;
            errorDiv.style.display = 'block';
        }
    }
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==========================================
// ADMIN: ANALYTICS TAB
// ==========================================
async function loadAnalytics(rangeType) {
    (document.querySelectorAll('.filter-btn') || []).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === rangeType);
    });

    const customFields = document.getElementById('custom-date-fields');
    if (rangeType === 'custom') {
        customFields.style.display = 'flex';
    } else {
        customFields.style.display = 'none';
    }

    const bills = await getAllBills() || [];
    let filteredBills = [];

    const now = new Date();
    const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    let startTimestamp = 0;
    let endTimestamp = Infinity;

    if (rangeType === 'today') {
        startTimestamp = todayDate.getTime();
        filteredBills = (bills || []).filter(b => {
            const orig = b.originalBill || b;
            return orig.dateTimestamp >= startTimestamp;
        });
    } else if (rangeType === 'yesterday') {
        const yesterdayDate = new Date(todayDate);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        startTimestamp = yesterdayDate.getTime();
        endTimestamp = todayDate.getTime();
        filteredBills = (bills || []).filter(b => {
            const orig = b.originalBill || b;
            const ts = orig.dateTimestamp;
            return ts >= startTimestamp && ts < endTimestamp;
        });
    } else if (rangeType === '7days') {
        const sevenDaysAgo = new Date(todayDate);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        startTimestamp = sevenDaysAgo.getTime();
        filteredBills = (bills || []).filter(b => {
            const orig = b.originalBill || b;
            return orig.dateTimestamp >= startTimestamp;
        });
    } else if (rangeType === '30days') {
        const thirtyDaysAgo = new Date(todayDate);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        startTimestamp = thirtyDaysAgo.getTime();
        filteredBills = (bills || []).filter(b => {
            const orig = b.originalBill || b;
            return orig.dateTimestamp >= startTimestamp;
        });
    } else if (rangeType === 'custom') {
        const startVal = document.getElementById('analytics-start-date').value;
        const endVal = document.getElementById('analytics-end-date').value;
        if (startVal && endVal) {
            const startDate = new Date(startVal);
            const endDate = new Date(endVal);
            endDate.setHours(23, 59, 59, 999);
            startTimestamp = startDate.getTime();
            endTimestamp = endDate.getTime();
            filteredBills = (bills || []).filter(b => {
                const orig = b.originalBill || b;
                const ts = orig.dateTimestamp;
                return ts >= startTimestamp && ts <= endTimestamp;
            });
        }
    }

    // Metrics compilation
    let originalSalesRevenue = 0;
    let productsSold = 0;
    let cashTotal = 0;
    let upiTotal = 0;
    let exchangeTotal = 0;
    const itemMap = {};

    (filteredBills || []).forEach(b => {
        // Use the original bill for historical original sale metrics
        const origBill = b.originalBill || b;
        originalSalesRevenue += origBill.grandTotal;
        
        const cashAmt = origBill.cashAmount !== undefined ? origBill.cashAmount : (origBill.paymentMode === 'Cash' ? origBill.grandTotal : 0);
        const upiAmt = origBill.upiAmount !== undefined ? origBill.upiAmount : (origBill.paymentMode === 'UPI' ? origBill.grandTotal : 0);
        cashTotal += cashAmt;
        upiTotal += upiAmt;

        const bItems = origBill.items || [];
        (bItems || []).forEach(item => {
            productsSold += item.qty;
            const key = `${item.code}-${item.size}`;
            if (!itemMap[key]) {
                itemMap[key] = { name: item.name, code: item.code, size: item.size, qty: 0, revenue: 0 };
            }
            itemMap[key].qty += item.qty;
            itemMap[key].revenue += item.total;
        });
    });

    // Scan ALL bills to sum exchange differences in this range
    (bills || []).forEach(b => {
        if (b.editHistory && Array.isArray(b.editHistory)) {
            b.editHistory.forEach(entry => {
                const entryTime = new Date(entry.updatedAt).getTime();
                if (entryTime >= startTimestamp && entryTime < endTimestamp) {
                    exchangeTotal += (entry.exchangeDifference || 0);
                }
            });
        }
    });

    // Revenue represents final business revenue: Today's new sales + Today's Exchange Amount
    const finalRevenue = originalSalesRevenue + exchangeTotal;

    document.getElementById('report-revenue').innerText = `₹${finalRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('report-bills').innerText = filteredBills.length;
    document.getElementById('report-items').innerText = productsSold;
    document.getElementById('report-cash').innerText = `₹${cashTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('report-upi').innerText = `₹${upiTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    
    // Exchange Amount with + or - sign
    const sign = exchangeTotal > 0 ? '+' : '';
    const exchangeValEl = document.getElementById('report-exchange');
    exchangeValEl.innerText = `${sign}₹${exchangeTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    if (exchangeTotal > 0) {
        exchangeValEl.style.color = 'var(--success)';
    } else if (exchangeTotal < 0) {
        exchangeValEl.style.color = 'var(--danger)';
    } else {
        exchangeValEl.style.color = 'var(--text-primary)';
    }

    const topProducts = Object.values(itemMap);
    topProducts.sort((a, b) => b.qty - a.qty);

    const topTbody = document.getElementById('report-top-products');
    if (topProducts.length === 0) {
        topTbody.innerHTML = '<tr><td colspan="4" class="text-center pad-y-md text-muted">No products sold in this period.</td></tr>';
    } else {
        topTbody.innerHTML = (topProducts || []).slice(0, 5).map((p, idx) => `
            <tr>
                <td class="text-center font-bold">${idx + 1}</td>
                <td>
                    <div class="cart-prod-title">${p.name}-${p.size}</div>
                    <div class="cart-prod-sub">Code: ${p.code}</div>
                </td>
                <td class="text-center font-medium">${p.qty}</td>
                <td class="text-right font-medium">₹${p.revenue.toFixed(2)}</td>
            </tr>
        `).join('');
    }

    renderRevenueSVGChart(filteredBills, rangeType);
}

function renderRevenueSVGChart(bills, rangeType) {
    const chartContainer = document.getElementById('report-chart-container');
    chartContainer.innerHTML = '';

    if (!bills || bills.length === 0) {
        chartContainer.innerHTML = '<div class="chart-empty">No sales data available.</div>';
        return;
    }

    const dailySales = {};
    (bills || []).forEach(b => {
        const origBill = b.originalBill || b;
        if (!dailySales[origBill.date]) {
            dailySales[origBill.date] = { date: origBill.date, revenue: 0, timestamp: origBill.dateTimestamp };
        }
        dailySales[origBill.date].revenue += origBill.grandTotal;
    });

    const dataPoints = Object.values(dailySales);
    dataPoints.sort((a, b) => a.timestamp - b.timestamp);

    const maxRevenue = Math.max(...(dataPoints || []).map(d => d.revenue), 100);

    const width = 600;
    const height = 180;
    const padding = 30;
    const chartWidth = width - (padding * 2);
    const chartHeight = height - (padding * 2);

    let barsHtml = '';
    const barWidth = Math.max((chartWidth / dataPoints.length) - 10, 5);
    const spacing = (chartWidth - (barWidth * dataPoints.length)) / (dataPoints.length > 1 ? (dataPoints.length - 1) : 1);

    (dataPoints || []).forEach((d, idx) => {
        const x = padding + (idx * (barWidth + spacing));
        const barHeight = (d.revenue / maxRevenue) * chartHeight;
        const y = height - padding - barHeight;

        barsHtml += `
            <g class="chart-bar-group">
                <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4" fill="url(#barGradient)" />
                <text x="${x + (barWidth / 2)}" y="${y - 8}" text-anchor="middle" class="chart-label-val">₹${Math.round(d.revenue)}</text>
                <text x="${x + (barWidth / 2)}" y="${height - 10}" text-anchor="middle" class="chart-label-date">${d.date.substring(0, 5)}</text>
            </g>
        `;
    });

    chartContainer.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" class="sales-chart-svg">
            <defs>
                <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent-primary)" />
                    <stop offset="100%" stop-color="var(--accent-secondary)" />
                </linearGradient>
            </defs>
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border-color)" stroke-width="1" />
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="var(--border-color)" stroke-dasharray="4" stroke-width="1" />
            ${barsHtml}
        </svg>
    `;
}

// ==========================================
// ADMIN: INVENTORY MANAGEMENT TAB
// ==========================================
let editingProductCode = null;

function addSizeRow(size = '', price = '', stock = '') {
    const list = document.getElementById('product-sizes-list');
    const row = document.createElement('div');
    row.className = 'size-row';
    row.innerHTML = `
        <input type="text" class="input-styled size-input" placeholder="Size" value="${size}" style="flex: 2; height: 38px;" required>
        <input type="number" class="input-styled price-input" placeholder="Price (₹)" min="0.01" step="0.01" value="${price}" style="flex: 2; height: 38px;" required>
        <input type="number" class="input-styled stock-input" placeholder="Stock" min="0" value="${stock}" style="flex: 2; height: 38px;" required>
        <button type="button" class="size-remove-btn" onclick="removeSizeRow(this)">&times;</button>
    `;
    list.appendChild(row);
}

function removeSizeRow(btn) {
    const row = btn.parentElement;
    row.remove();
}

async function renderInventoryList() {
    const products = await getAllProducts() || [];
    const query = document.getElementById('inventory-search').value.toLowerCase().trim();

    const filtered = (products || []).filter(p => 
        (p.code || '').toLowerCase().includes(query) || 
        (p.name || '').toLowerCase().includes(query) ||
        (p.category || '').toLowerCase().includes(query)
    );

    const tbody = document.getElementById('inventory-tbody');
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center pad-y-md text-muted">No products found in inventory.</td></tr>';
        return;
    }

    tbody.innerHTML = (filtered || []).map(p => {
        const sizesList = p.sizes || [];
        const sizesHtml = (sizesList || []).map(s => `
            <div style="margin-bottom: 2px; font-size: 0.8rem;">
                <span class="size-badge">${s.size}</span> 
                <strong>₹${s.price}</strong> 
                <span class="stock-badge ${s.stock === 0 ? 'badge-out' : (s.stock <= 5 ? 'badge-low' : 'badge-normal')}">
                    ${s.stock} units
                </span>
            </div>
        `).join('');

        return `
            <tr>
                <td class="font-medium">${p.code}</td>
                <td class="font-medium">${p.name}</td>
                <td>${p.category}</td>
                <td colspan="2">${sizesHtml}</td>
                <td class="text-center">
                    <div class="actions-group">
                        <button class="btn-action edit" onclick="openProductEditModal('${p.code}')">Edit</button>
                        <button class="btn-action delete" onclick="handleDeleteProduct('${p.code}')">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function openProductAddModal() {
    editingProductCode = null;
    document.getElementById('product-modal-title').innerText = 'Add New Product';
    
    document.getElementById('prod-code').value = '';
    document.getElementById('prod-code').disabled = false;
    document.getElementById('prod-name').value = '';
    document.getElementById('prod-category').value = '';
    
    document.getElementById('product-sizes-list').innerHTML = '';
    addSizeRow('', '', '');
    
    document.getElementById('product-modal').style.display = 'flex';
}

async function openProductEditModal(code) {
    const product = await getProduct(code);
    if (!product) return;

    editingProductCode = code;
    document.getElementById('product-modal-title').innerText = 'Edit Product';
    
    document.getElementById('prod-code').value = product.code;
    document.getElementById('prod-code').disabled = true;
    document.getElementById('prod-name').value = product.name;
    document.getElementById('prod-category').value = product.category;

    const container = document.getElementById('product-sizes-list');
    container.innerHTML = '';
    (product.sizes || []).forEach(s => {
        addSizeRow(s.size, s.price, s.stock);
    });

    document.getElementById('product-modal').style.display = 'flex';
}

function closeProductModal() {
    document.getElementById('product-modal').style.display = 'none';
    editingProductCode = null;
}

async function handleSaveProduct(event) {
    event.preventDefault();

    const code = document.getElementById('prod-code').value.trim();
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value.trim();

    if (!code || !name || !category) {
        showToast('Please fill all basic fields.', 'warning');
        return;
    }

    const sizeRows = document.querySelectorAll('.size-row');
    const sizes = [];
    let sizeValidationFailed = false;

    (sizeRows || []).forEach(row => {
        const sizeVal = row.querySelector('.size-input').value.trim();
        const priceVal = parseFloat(row.querySelector('.price-input').value);
        const stockVal = parseInt(row.querySelector('.stock-input').value);

        if (!sizeVal || isNaN(priceVal) || isNaN(stockVal)) {
            sizeValidationFailed = true;
            return;
        }

        sizes.push({ size: sizeVal, price: priceVal, stock: stockVal });
    });

    if (sizeValidationFailed) {
        showToast('Please fill all size, price, and stock inputs correctly.', 'warning');
        return;
    }

    if (sizes.length === 0) {
        showToast('Please add at least one size for the product.', 'warning');
        return;
    }

    if (editingProductCode === null) {
        const existing = await getProduct(code);
        if (existing) {
            showToast(`Product code ${code} already exists in database.`, 'error');
            return;
        }
    }

    try {
        await saveProduct({ code, name, category, sizes });
        showToast('Product saved successfully', 'success');
        closeProductModal();
        await refreshProductsCache();
        renderInventoryList();
    } catch (e) {
        showToast('Failed to save product: ' + e.message, 'error');
    }
}

async function handleDeleteProduct(code) {
    if (confirm(`Are you sure you want to delete product: ${code}?`)) {
        try {
            await deleteProduct(code);
            showToast('Product deleted from inventory', 'info');
            await refreshProductsCache();
            renderInventoryList();
        } catch (e) {
            showToast('Deletion failed: ' + e.message, 'error');
        }
    }
}

// ==========================================
// ADMIN: BILLS HISTORY TAB
// ==========================================
async function renderBillsList() {
    const bills = await getAllBills() || [];
    const query = document.getElementById('bills-search').value.toLowerCase().trim();

    let filtered = [];
    const numericQuery = query.replace(/\D/g, '');

    filtered = (bills || []).filter(b => {
        // Match bill number (partial/exact) or date
        const matchesBillOrDate = (b.id || '').toLowerCase().includes(query) || (b.date || '').includes(query);
        
        // Match cashier name (case-insensitive partial/exact)
        const matchesCashier = (b.cashier || '').toLowerCase().includes(query);
        
        // Match customer mobile number (partial or full)
        const cleanMobile = (b.customerMobile || '').replace(/\D/g, '');
        let matchesMobile = false;
        
        if (numericQuery.length > 0) {
            if (numericQuery.length >= 10) {
                // For full number, compare last 10 digits
                const last10Query = numericQuery.slice(-10);
                const last10Mobile = cleanMobile.slice(-10);
                matchesMobile = (last10Mobile === last10Query);
            } else {
                // For partial number, check if cleaned mobile includes query
                matchesMobile = cleanMobile.includes(numericQuery) || cleanMobile.slice(-10).includes(numericQuery);
            }
        }

        return matchesBillOrDate || matchesMobile || matchesCashier;
    });

    // Sort matching results by dateTimestamp (Latest -> Oldest)
    filtered.sort((a, b) => b.dateTimestamp - a.dateTimestamp);

    const tbody = document.getElementById('bills-tbody');
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center pad-y-md text-muted">No matching transactions found.</td></tr>';
        return;
    }

    tbody.innerHTML = (filtered || []).map(b => {
        const lastUpdated = formatLastUpdated(b.updatedAt);
        return `
            <tr>
                <td class="font-medium">${b.id}</td>
                <td>${b.date} <span class="text-muted text-sm">${b.time}</span></td>
                <td>${b.customerMobile || '-'}</td>
                <td class="text-center font-medium">${(b.items || []).length} items (${b.paymentMode})</td>
                <td class="text-right font-medium">₹${b.grandTotal.toFixed(2)}</td>
                <td>${lastUpdated}</td>
                <td class="text-center">
                    <div class="actions-group">
                        <button class="btn-action view" onclick="viewBillDetails('${b.id}')">View</button>
                        <button class="btn-action edit" onclick="handleEditBillClick('${b.id}')">Edit</button>
                        <button class="btn-action delete" onclick="promptDeleteBill('${b.id}')">Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

let billIdToDelete = null;

function promptDeleteBill(billId) {
    billIdToDelete = billId;
    document.getElementById('delete-reason-input').value = '';
    document.getElementById('delete-bill-modal').style.display = 'flex';
}

function closeDeleteBillModal() {
    document.getElementById('delete-bill-modal').style.display = 'none';
    billIdToDelete = null;
}

async function confirmDeleteBill() {
    if (!billIdToDelete) return;
    const reason = document.getElementById('delete-reason-input').value.trim();

    if (!reason) {
        showToast('Please state a reason for bill deletion.', 'warning');
        return;
    }

    try {
        await deleteBill(billIdToDelete, reason);
        showToast(`Bill ${billIdToDelete} successfully deleted. Stocks restored.`, 'success');
        closeDeleteBillModal();
        await refreshProductsCache();
        await renderBillsList();
    } catch (e) {
        showToast('Error deleting transaction: ' + e.message, 'error');
        closeDeleteBillModal();
    }
}

// ==========================================
// ADMIN: SETTINGS TAB
// ==========================================
async function loadSettingsTab() {
    const logs = await getAuditLogs() || [];
    const logTbody = document.getElementById('audit-logs-tbody');

    if (logs.length === 0) {
        logTbody.innerHTML = '<tr><td colspan="3" class="text-center pad-y-sm text-muted">No actions recorded.</td></tr>';
    } else {
        logTbody.innerHTML = (logs.slice(0, 25) || []).map(l => {
            const date = new Date(l.timestamp);
            const formattedDate = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            return `
                <tr>
                    <td class="text-muted text-sm">${formattedDate}</td>
                    <td class="font-medium text-sm">${l.action}</td>
                    <td class="text-sm">${l.details}</td>
                </tr>
            `;
        }).join('');
    }
}

async function handleExportBackup() {
    try {
        const jsonStr = await exportBackupJSON();
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `kids_trends_backup_${dateStr}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        showToast('Backup downloaded successfully', 'success');
        await logActivity('Backup Exported', 'JSON database backup downloaded');
    } catch (e) {
        showToast('Backup failed: ' + e.message, 'error');
    }
}

function handleImportBackup(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const result = e.target.result;
            if (confirm('Restoring will overwrite all existing local database entries. Proceed?')) {
                await restoreBackupJSON(result);
                showToast('Database restored successfully! Reloading...', 'success');
                setTimeout(() => window.location.reload(), 1500);
            }
        } catch (err) {
            showToast('Restore failed: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
}

async function handleUpdatePin(event) {
    event.preventDefault();
    const oldPin = document.getElementById('pin-old').value.trim();
    const newPin = document.getElementById('pin-new').value.trim();
    const confirmPin = document.getElementById('pin-confirm').value.trim();

    if (!oldPin || !newPin || !confirmPin) {
        showToast('Please enter password details.', 'warning');
        return;
    }

    if (newPin !== confirmPin) {
        showToast('New passwords do not match.', 'error');
        return;
    }

    try {
        const storedHash = await getSetting('admin_pin_hash', DEFAULT_PIN_HASH);
        const oldHash = await sha256(oldPin);

        if (oldHash !== storedHash) {
            showToast('Incorrect old password.', 'error');
            return;
        }

        const newHash = await sha256(newPin);
        await setSetting('admin_pin_hash', newHash);
        showToast('Security password updated successfully!', 'success');
        
        document.getElementById('pin-old').value = '';
        document.getElementById('pin-new').value = '';
        document.getElementById('pin-confirm').value = '';

        await logActivity('Admin PIN Changed', 'Hashed password updated');

    } catch (e) {
        showToast('Password update failed: ' + e.message, 'error');
    }
}

// ==========================================
// EDITABLE BILLS & EXCHANGES FLOW
// ==========================================

function formatLastUpdated(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '—';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${day} ${month} ${year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

async function handleEditBillClick(billId) {
    try {
        const bill = await getBill(billId);
        if (!bill) {
            showToast('Bill not found', 'error');
            return;
        }

        // 1. Set edit mode state
        state.editingBillId = billId;

        // 2. Load cashier selection
        state.cashier = bill.cashier || 'Irfan';
        (document.querySelectorAll('.btn-toggle-cashier') || []).forEach(x => {
            x.classList.toggle('active', x.dataset.cashier === state.cashier);
        });

        // 3. Load customer mobile
        const mobileField = document.getElementById('customer-mobile');
        if (mobileField) mobileField.value = bill.customerMobile || '';

        // 4. Load discount details
        state.discountType = bill.discountType || 'percentage';
        state.discountValue = bill.discountValue || 0;
        const discountTypeSelect = document.getElementById('billing-discount-type');
        const discountValueInput = document.getElementById('billing-discount-value');
        if (discountTypeSelect) discountTypeSelect.value = state.discountType;
        if (discountValueInput) discountValueInput.value = state.discountValue;

        // 5. Load payment mode
        state.paymentMode = bill.paymentMode || 'Cash';
        (document.querySelectorAll('.btn-toggle-pay') || []).forEach(x => {
            x.classList.toggle('active', x.dataset.mode === state.paymentMode);
        });

        // 6. Load cart items, checking their inventory stock dynamically
        state.cart = [];
        for (const item of bill.items) {
            const product = (state.allProducts || []).find(p => p.code === item.code);
            let currentStock = 0;
            if (product) {
                const sizeObj = (product.sizes || []).find(s => s.size === String(item.size).trim());
                if (sizeObj) {
                    currentStock = sizeObj.stock;
                }
            }
            state.cart.push({
                code: item.code,
                name: item.name,
                size: item.size,
                price: item.price,
                stock: currentStock + item.qty, // cashier can choose up to (current inventory + what was already bought in this bill)
                qty: item.qty
            });
        }

        // 7. Update UI banner
        const banner = document.getElementById('edit-bill-banner');
        const displayId = document.getElementById('edit-bill-id-display');
        if (banner && displayId) {
            displayId.innerText = billId;
            banner.style.display = 'flex';
        }

        // 8. Update Checkout button text
        const checkoutBtn = document.getElementById('btn-checkout');
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.innerText = 'Update Bill';
        }

        // 9. Switch to Billing Section & render cart
        switchSection('bill');
        renderCart();
        showToast(`Editing Bill ${billId}`, 'info');

    } catch (e) {
        showToast('Failed to load bill for editing: ' + e.message, 'error');
    }
}

function cancelBillEdit() {
    state.editingBillId = null;
    state.cart = [];
    resetBillingInputs();

    // Hide banner
    const banner = document.getElementById('edit-bill-banner');
    if (banner) banner.style.display = 'none';

    // Restore button text
    const checkoutBtn = document.getElementById('btn-checkout');
    if (checkoutBtn) {
        checkoutBtn.innerText = 'Proceed Checkout';
    }

    // Go back to sales history
    switchSection('admin');
    switchAdminTab('bills');
    showToast('Editing cancelled', 'info');
}

function openRestoreConfirmModal() {
    if (!state.editingBillId) return;
    document.getElementById('restore-confirm-modal').style.display = 'flex';
}

function closeRestoreConfirmModal() {
    document.getElementById('restore-confirm-modal').style.display = 'none';
}

async function confirmRestoreOriginalBill() {
    if (!state.editingBillId) return;
    closeRestoreConfirmModal();
    try {
        const restoredBill = await restoreBillToOriginal(state.editingBillId);
        showToast(`Bill ${restoredBill.id} restored to original state!`, 'success');
        
        // Reload restored bill in the editor
        await refreshProductsCache();
        await handleEditBillClick(state.editingBillId);
    } catch (e) {
        showToast('Failed to restore bill: ' + e.message, 'error');
    }
}

async function confirmSaveBillEdit() {
    document.getElementById('edit-confirm-modal').style.display = 'none';

    const checkoutBtn = document.getElementById('btn-checkout');
    checkoutBtn.disabled = true;
    checkoutBtn.innerText = 'Updating...';

    const mobileField = document.getElementById('customer-mobile');
    const customerMobile = mobileField ? mobileField.value.trim() : '';

    try {
        const billRecord = await updateBill(
            state.editingBillId,
            state.cart,
            { type: state.discountType, value: state.discountValue },
            state.paymentMode,
            customerMobile,
            state.cashier || 'Irfan'
        );

        showToast(`Bill ${billRecord.id} updated successfully!`, 'success');

        // Hide edit banner
        const banner = document.getElementById('edit-bill-banner');
        if (banner) banner.style.display = 'none';

        checkoutBtn.innerText = 'Proceed Checkout';
        
        state.editingBillId = null;
        state.cart = [];
        resetBillingInputs();

        await refreshProductsCache();
        
        showReceiptModal(billRecord);
        downloadBillImage(billRecord);

    } catch (err) {
        showToast(err.message, 'error');
        checkoutBtn.disabled = false;
        checkoutBtn.innerText = 'Update Bill';
    }
}

// ==========================================
// EVENT LISTENERS & SETUP
// ==========================================
function setupEventListeners() {
    // Bottom Navigation Tab switches
    document.getElementById('nav-home').addEventListener('click', () => switchSection('home'));
    document.getElementById('nav-bill').addEventListener('click', () => switchSection('bill'));
    document.getElementById('nav-admin').addEventListener('click', () => handleAdminQuickAction('analytics'));

    // Customer Mobile constraints (digits only, max 10)
    const mobileInput = document.getElementById('customer-mobile');
    if (mobileInput) {
        mobileInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/\D/g, '');
            if (e.target.value.length > 10) {
                e.target.value = e.target.value.slice(0, 10);
            }
        });
    }

    // Billing Search & Autocomplete suggestions
    const searchInput = document.getElementById('billing-search');
    searchInput.addEventListener('input', (e) => handleSearchInput(e.target.value));
    searchInput.addEventListener('focus', (e) => handleSearchInput(e.target.value));

    // Hide search suggestions when tapping outside
    document.addEventListener('click', (e) => {
        const suggest = document.getElementById('search-suggestions');
        if (e.target !== searchInput && !suggest.contains(e.target)) {
            suggest.style.display = 'none';
        }
    });

    // Discount options
    document.getElementById('billing-discount-type').addEventListener('change', (e) => {
        state.discountType = e.target.value;
        const valField = document.getElementById('billing-discount-value');
        state.discountValue = parseFloat(valField.value) || 0;
        renderCart();
    });

    document.getElementById('billing-discount-value').addEventListener('input', (e) => {
        state.discountValue = parseFloat(e.target.value) || 0;
        renderCart();
    });

    // Payment Mode Segment Toggle Selection
    (document.querySelectorAll('.btn-toggle-pay') || []).forEach(btn => {
        btn.addEventListener('click', (e) => {
            (document.querySelectorAll('.btn-toggle-pay') || []).forEach(x => x.classList.remove('active'));
            const targetBtn = e.target.closest('.btn-toggle-pay');
            targetBtn.classList.add('active');
            state.paymentMode = targetBtn.dataset.mode;
        });
    });

    // Cashier Segment Toggle Selection
    (document.querySelectorAll('.btn-toggle-cashier') || []).forEach(btn => {
        btn.addEventListener('click', (e) => {
            (document.querySelectorAll('.btn-toggle-cashier') || []).forEach(x => x.classList.remove('active'));
            const targetBtn = e.target.closest('.btn-toggle-cashier');
            targetBtn.classList.add('active');
            state.cashier = targetBtn.dataset.cashier;
        });
    });

    // Scanner UI
    document.getElementById('btn-scan-product').addEventListener('click', openScannerOverlay);
    document.getElementById('btn-close-scanner').addEventListener('click', closeScannerOverlay);

    // Admin login password submit listener
    document.getElementById('admin-login-form').addEventListener('submit', handleAdminLoginSubmit);
    document.getElementById('btn-lock-admin').addEventListener('click', lockAdmin);

    // Admin password recovery modal event listeners
    const forgotPasswordLink = document.getElementById('forgot-password-link');
    if (forgotPasswordLink) {
        forgotPasswordLink.addEventListener('click', (e) => {
            e.preventDefault();
            openResetPasswordModal();
        });
    }
    
    const btnCloseResetModal = document.getElementById('btn-close-reset-modal');
    if (btnCloseResetModal) {
        btnCloseResetModal.addEventListener('click', closeResetPasswordModal);
    }
    
    const resetModalOverlay = document.getElementById('reset-password-modal');
    if (resetModalOverlay) {
        resetModalOverlay.addEventListener('click', (e) => {
            if (e.target === resetModalOverlay) {
                closeResetPasswordModal();
            }
        });
    }

    const resetStep1Form = document.getElementById('reset-step-1-form');
    if (resetStep1Form) {
        resetStep1Form.addEventListener('submit', handleResetStep1Submit);
    }

    const resetStep2Form = document.getElementById('reset-step-2-form');
    if (resetStep2Form) {
        resetStep2Form.addEventListener('submit', handleResetStep2Submit);
    }

    // Checkout
    document.getElementById('btn-checkout').addEventListener('click', handleCheckout);

    // Receipt closing / actions
    document.getElementById('btn-close-receipt').addEventListener('click', closeReceiptModal);
    document.getElementById('btn-whatsapp-receipt').addEventListener('click', handleWhatsAppShare);
    document.getElementById('btn-print-receipt').addEventListener('click', printActiveReceipt);

    // Admin Tabs Swaps
    (document.querySelectorAll('.admin-tab-btn') || []).forEach(btn => {
        btn.addEventListener('click', (e) => {
            switchAdminTab(e.target.dataset.tab);
        });
    });

    // Analytics Filters
    (document.querySelectorAll('.filter-btn') || []).forEach(btn => {
        btn.addEventListener('click', (e) => {
            loadAnalytics(e.target.dataset.range);
        });
    });

    document.getElementById('analytics-start-date').addEventListener('change', () => loadAnalytics('custom'));
    document.getElementById('analytics-end-date').addEventListener('change', () => loadAnalytics('custom'));

    // Inventory Product Grid Save & Edit Row
    document.getElementById('inventory-search').addEventListener('input', renderInventoryList);
    document.getElementById('btn-add-product').addEventListener('click', openProductAddModal);
    document.getElementById('btn-add-size-row').addEventListener('click', () => addSizeRow('', '', ''));
    document.getElementById('product-form').addEventListener('submit', handleSaveProduct);
    document.getElementById('btn-close-prod-modal').addEventListener('click', closeProductModal);

    // Bills History deletion and searches
    document.getElementById('bills-search').addEventListener('input', renderBillsList);
    document.getElementById('btn-close-delbill-modal').addEventListener('click', closeDeleteBillModal);
    document.getElementById('btn-confirm-delete-bill').addEventListener('click', confirmDeleteBill);

    // Settings
    document.getElementById('btn-export-backup').addEventListener('click', handleExportBackup);
    document.getElementById('backup-import-file').addEventListener('change', handleImportBackup);
    document.getElementById('pin-change-form').addEventListener('submit', handleUpdatePin);

    // Edit bill banner actions
    document.getElementById('btn-restore-bill').addEventListener('click', openRestoreConfirmModal);
    document.getElementById('btn-cancel-edit-bill').addEventListener('click', cancelBillEdit);

    // Edit confirm modal actions
    document.getElementById('btn-close-edit-confirm').addEventListener('click', () => {
        document.getElementById('edit-confirm-modal').style.display = 'none';
        const checkoutBtn = document.getElementById('btn-checkout');
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.innerText = 'Update Bill';
        }
    });
    document.getElementById('btn-cancel-edit-confirm').addEventListener('click', () => {
        document.getElementById('edit-confirm-modal').style.display = 'none';
        const checkoutBtn = document.getElementById('btn-checkout');
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.innerText = 'Update Bill';
        }
    });
    document.getElementById('btn-save-edit-confirm').addEventListener('click', confirmSaveBillEdit);

    // Restore confirm modal actions
    document.getElementById('btn-close-restore-confirm').addEventListener('click', closeRestoreConfirmModal);
    document.getElementById('btn-cancel-restore-confirm').addEventListener('click', closeRestoreConfirmModal);
    document.getElementById('btn-confirm-restore-bill').addEventListener('click', confirmRestoreOriginalBill);

    // Home screen Insights details popups
    document.getElementById('insight-available').addEventListener('click', () => openInsightsDetail('available'));
    document.getElementById('insight-outofstock').addEventListener('click', () => openInsightsDetail('outofstock'));
    document.getElementById('insight-lowstock').addEventListener('click', () => openInsightsDetail('lowstock'));
    document.getElementById('insight-fastselling').addEventListener('click', () => openInsightsDetail('fastselling'));

    // Cloud Backup Event Listeners
    const cloudBackupCard = document.getElementById('cloud-backup-card');
    if (cloudBackupCard) {
        cloudBackupCard.addEventListener('click', () => {
            const modal = document.getElementById('cloud-password-modal');
            if (modal) modal.style.display = 'flex';
            const input = document.getElementById('cloud-password-input');
            if (input) {
                input.value = '';
                input.focus();
            }
        });
    }

    const btnCloseCloudPW = document.getElementById('btn-close-cloud-pw-modal');
    if (btnCloseCloudPW) {
        btnCloseCloudPW.addEventListener('click', closeCloudPasswordModal);
    }

    const cloudForgotLink = document.getElementById('cloud-forgot-pw-link');
    if (cloudForgotLink) {
        cloudForgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            closeCloudPasswordModal();
            const forgotModal = document.getElementById('cloud-forgot-password-modal');
            if (forgotModal) {
                forgotModal.style.display = 'flex';
                const input = document.getElementById('cloud-recovery-code-input');
                if (input) {
                    input.value = '';
                    input.focus();
                }
            }
        });
    }

    const cloudPWForm = document.getElementById('cloud-password-form');
    if (cloudPWForm) {
        cloudPWForm.addEventListener('submit', handleCloudPasswordSubmit);
    }

    const btnCloseCloudForgot = document.getElementById('btn-close-cloud-forgot-modal');
    if (btnCloseCloudForgot) {
        btnCloseCloudForgot.addEventListener('click', closeCloudForgotPasswordModal);
    }

    const cloudRecoveryStep1 = document.getElementById('cloud-recovery-step-1-form');
    if (cloudRecoveryStep1) {
        cloudRecoveryStep1.addEventListener('submit', handleCloudRecoveryStep1Submit);
    }

    const cloudRecoveryStep2 = document.getElementById('cloud-recovery-step-2-form');
    if (cloudRecoveryStep2) {
        cloudRecoveryStep2.addEventListener('submit', handleCloudRecoveryStep2Submit);
    }

    const btnCloseCloudPanel = document.getElementById('btn-close-cloud-panel-modal');
    if (btnCloseCloudPanel) {
        btnCloseCloudPanel.addEventListener('click', closeCloudBackupPanelModal);
    }

    const btnCloudUpload = document.getElementById('btn-cloud-upload-now');
    if (btnCloudUpload) {
        btnCloudUpload.addEventListener('click', handleCloudUploadNowClick);
    }

    const btnCloudUndo = document.getElementById('btn-cloud-undo-restore');
    if (btnCloudUndo) {
        btnCloudUndo.addEventListener('click', handleCloudUndoRestoreClick);
    }

    const cloudChangePWForm = document.getElementById('cloud-change-pw-form');
    if (cloudChangePWForm) {
        cloudChangePWForm.addEventListener('submit', handleCloudChangePWSubmit);
    }

    const cloudPWModal = document.getElementById('cloud-password-modal');
    if (cloudPWModal) {
        cloudPWModal.addEventListener('click', (e) => {
            if (e.target === cloudPWModal) closeCloudPasswordModal();
        });
    }

    const cloudForgotModal = document.getElementById('cloud-forgot-password-modal');
    if (cloudForgotModal) {
        cloudForgotModal.addEventListener('click', (e) => {
            if (e.target === cloudForgotModal) closeCloudForgotPasswordModal();
        });
    }

    const cloudPanelModal = document.getElementById('cloud-backup-panel-modal');
    if (cloudPanelModal) {
        cloudPanelModal.addEventListener('click', (e) => {
            if (e.target === cloudPanelModal) closeCloudBackupPanelModal();
        });
    }

    // Network status
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();
}

function updateNetworkStatus() {
    const badge = document.getElementById('connection-status');
    if (navigator.onLine) {
        badge.innerText = 'Online';
        badge.className = 'status-badge online';
    } else {
        badge.innerText = 'Offline Mode';
        badge.className = 'status-badge offline';
    }
}

// ==========================================
// TOASTS & UX EFFECTS
// ==========================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('visible'), 10);

    setTimeout(() => {
        toast.classList.remove('visible');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3500);
}

// Tiny audio synthesis for scanning beep
function playBeepSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime);
        
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
        // Silent catch for audio policy browser rules
    }
}

// ==========================================
// WHATSAPP BILL SHARING & CANVAS GENERATION
// ==========================================
async function handleWhatsAppShare() {
    const bill = state.activeBill;
    if (!bill) {
        showToast("No active bill to share", "error");
        return;
    }

    let mobileNumber = bill.customerMobile;
    if (!mobileNumber) {
        showToast("Please enter the customer's mobile number to share via WhatsApp.", "warning");
        const userMobile = prompt("Please enter customer's 10-digit mobile number:");
        if (userMobile) {
            const cleanMobile = userMobile.replace(/\D/g, '');
            if (cleanMobile.length === 10) {
                mobileNumber = cleanMobile;
                bill.customerMobile = mobileNumber;
                try {
                    await updateBillMobile(bill.id, mobileNumber);
                    showReceiptModal(bill);
                    showToast("Mobile number updated successfully!", "success");
                } catch (dbErr) {
                    console.error("Failed to save mobile number:", dbErr);
                }
            } else {
                showToast("Invalid number! Must be exactly 10 digits.", "error");
                return;
            }
        } else {
            return;
        }
    }

    let cleanMobile = mobileNumber.replace(/\D/g, '');
    if (cleanMobile.length === 10) {
        cleanMobile = '91' + cleanMobile;
    }

    const message = `Here is your bill from Kid's Trends (Bill No: ${bill.id})`;
    const whatsappUrl = `https://wa.me/${cleanMobile}?text=${encodeURIComponent(message)}`;

    // Open WhatsApp chat synchronously to avoid popup blocker
    window.open(whatsappUrl, '_blank');

    // Attempt to copy image to clipboard in the background as a fallback helper
    try {
        const canvas = generateReceiptCanvas(bill);
        canvas.toBlob(async (blob) => {
            if (blob) {
                try {
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    console.log("Receipt copied to clipboard.");
                } catch (clipErr) {
                    console.warn("Clipboard copy failed: ", clipErr);
                }
            }
        }, 'image/png');
    } catch (err) {
        console.error("Failed to copy image to clipboard in background:", err);
    }
}

function downloadBillImage(bill) {
    try {
        const canvas = generateReceiptCanvas(bill);
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `bill_${bill.id}.png`;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (err) {
        console.error("Failed to auto-download bill image:", err);
    }
}

function generateReceiptCanvas(bill) {
    const items = bill.items || [];
    const scale = 3; // 3x scaling for crystal-clear HD resolution
    const logicalWidth = 280;
    
    // Dynamically calculate logical height by tracing all canvas content vertical spaces
    let tempY = 30;
    tempY += 20; // KID'S TRENDS
    tempY += 16; // A Complete Kids Wear Collection
    tempY += 16; // Near Siddiq Shah Taleem
    tempY += 16; // Choubara Road, Bidar
    tempY += 16; // GSTIN
    tempY += 16; // Phone
    tempY += 12; // divider
    tempY += 18; // Bill No
    tempY += 16; // Date
    tempY += 16; // Time
    tempY += 16; // Cashier Name
    if (bill.customerMobile) {
        tempY += 16; // Customer Mobile
    }
    tempY += 12; // divider
    tempY += 18; // Headers
    tempY += 10; // divider
    
    items.forEach(() => {
        tempY += 20; // each item
    });
    
    tempY += 12; // divider
    tempY += 18; // Subtotal
    if (bill.discountAmount > 0) {
        tempY += 18; // Discount
    }
    tempY += 8;  // divider
    tempY += 20; // Grand Total
    tempY += 14; // Inclusive of all Taxes
    tempY += 8;  // divider
    tempY += 18; // Amount Paid
    tempY += 8;  // divider
    tempY += 20; // 8-Day Replacement Only (No Return)
    tempY += 20; // THANK YOU - VISIT AGAIN
    tempY += 20; // Software By www.scangrow.in
    tempY += 14; // No.
    
    // Add extra padding at the bottom to ensure no cropping occurs
    tempY += 25; 
    
    const logicalHeight = tempY;
    
    const canvas = document.createElement('canvas');
    canvas.width = logicalWidth * scale;
    canvas.height = logicalHeight * scale;
    
    const ctx = canvas.getContext('2d');
    
    // Scale drawings to produce high resolution output
    ctx.scale(scale, scale);
    
    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);
    
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    
    let y = 30;
    ctx.fillText("KID'S TRENDS", logicalWidth / 2, y);
    ctx.font = '12px monospace';
    y += 20;
    ctx.fillText("A Complete Kids Wear Collection", logicalWidth / 2, y);
    y += 16;
    ctx.fillText("Near Siddiq Shah Taleem", logicalWidth / 2, y);
    y += 16;
    ctx.fillText("Choubara Road, Bidar", logicalWidth / 2, y);
    y += 16;
    ctx.fillText("GSTIN: 29EEIPA4380H1ZE", logicalWidth / 2, y);
    y += 16;
    ctx.fillText("Phone: 8431520625, 8453554561", logicalWidth / 2, y);
    
    y += 12;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    ctx.textAlign = 'left';
    ctx.font = '12px monospace';
    y += 18;
    ctx.fillText(`Bill No: ${bill.id}`, 15, y);
    y += 16;
    ctx.fillText(`Date: ${bill.date}`, 15, y);
    y += 16;
    ctx.fillText(`Time: ${bill.time}`, 15, y);
    y += 16;
    ctx.fillText(`Cashier: ${bill.cashier || 'Irfan'}`, 15, y);
    if (bill.customerMobile) {
        y += 16;
        ctx.fillText(`Customer Mobile Number: ${bill.customerMobile}`, 15, y);
    }
    
    y += 12;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    y += 18;
    ctx.font = 'bold 12px monospace';
    ctx.fillText("ITEM", 15, y);
    ctx.textAlign = 'center';
    ctx.fillText("QTY", 150, y);
    ctx.textAlign = 'right';
    ctx.fillText("RATE", 215, y);
    ctx.fillText("TOTAL", 270, y);
    
    y += 10;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    ctx.font = '12px monospace';
    items.forEach(item => {
        y += 20;
        ctx.textAlign = 'left';
        let itemName = `${item.name}-${item.size}`;
        if (itemName.length > 14) itemName = itemName.substring(0, 18) + '..';
        ctx.fillText(itemName, 15, y);
        
        ctx.textAlign = 'center';
        ctx.fillText(String(item.qty), 150, y);
        
        ctx.textAlign = 'right';
        ctx.fillText(`₹${Math.round(item.price)}`, 215, y);
        ctx.fillText(`₹${Math.round(item.total)}`, 270, y);
    });
    
    y += 12;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    ctx.textAlign = 'left';
    y += 18;
    ctx.fillText("Subtotal:", 15, y);
    ctx.textAlign = 'right';
    ctx.fillText(`₹${bill.subtotal.toFixed(2)}`, 270, y);
    
    if (bill.discountAmount > 0) {
        y += 18;
        ctx.textAlign = 'left';
        ctx.fillText("Discount:", 15, y);
        ctx.textAlign = 'right';
        ctx.fillText(`₹${bill.discountAmount.toFixed(2)}`, 270, y);
    }
    
    y += 8;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    y += 20;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText("Grand Total:", 15, y);
    ctx.textAlign = 'right';
    ctx.fillText(`₹${bill.grandTotal.toFixed(2)}`, 270, y);
    
    y += 14;
    ctx.font = 'italic 10px monospace';
    ctx.fillText("(Inclusive of all Taxes)", 270, y);
    
    y += 8;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    y += 18;
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText("Amount Paid:", 15, y);
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(bill.paymentMode, 270, y);
    
    y += 8;
    drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
    
    y += 20;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText("8-Day Replacement Only (No Return)", logicalWidth / 2, y);
    
    y += 20;
    ctx.font = 'bold 12px monospace';
    ctx.fillText("THANK YOU - VISIT AGAIN", logicalWidth / 2, y);
    
    y += 20;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#555555';
    ctx.fillText("Software By www.scangrow.in", logicalWidth / 2, y);
    y += 14;
    ctx.fillText("WhatsApp No. 6364369405", logicalWidth / 2, y);
    
    return canvas;
}

function drawCanvasDivider(ctx, x1, x2, y) {
    ctx.beginPath();
    ctx.setLineDash([2, 2]);
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
}

// ==========================================
// CLOUD BACKUP SYSTEM (PHASE 1)
// ==========================================

function markBackupDirty() {
    state.backupDirty = true;
    state.cachedBackupJSON = null;
    state.cachedBackupSize = 0;
    state.cachedBackupHash = null;
}

/**
 * Recursively generates a stable, canonical JSON string representation of an object.
 * This guarantees key-order independence for identical business data payloads.
 */
function canonicalStringify(obj) {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(item => canonicalStringify(item)).join(',') + ']';
    }
    const sortedKeys = Object.keys(obj).sort();
    return '{' + sortedKeys.map(key => {
        return JSON.stringify(key) + ':' + canonicalStringify(obj[key]);
    }).join(',') + '}';
}

/**
 * Calculates a SHA-256 hash of the permanent business data in the backup JSON.
 * This filters out backup-system-specific logs and metadata to ensure hash stability.
 */
async function getDatabaseHash(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        let dataObj = parsed.data || parsed;
        
        // Deep copy business data to filter out system logs
        let businessData = JSON.parse(JSON.stringify(dataObj));
        
        // 1. Exclude cloud/backup audit logs from the hash calculation
        if (businessData.audit_logs && Array.isArray(businessData.audit_logs)) {
            const excludeActions = [
                'Cloud Backup Saved',
                'Cloud Backup Rotated',
                'Cloud Backup Restored',
                'Safety Rollback Created',
                'Cloud PW Changed',
                'Cloud PW Recovered'
            ];
            businessData.audit_logs = businessData.audit_logs.filter(log => !excludeActions.includes(log.action));
        }

        // 2. Exclude temporary or runtime keys from __localStorage__
        if (businessData.__localStorage__) {
            const keys = Object.keys(businessData.__localStorage__);
            keys.forEach(k => {
                if (k.startsWith('sb-') || 
                    k.startsWith('supabase.') ||
                    k === 'kids_trends_cloud_backups' ||
                    k === 'kids_trends_cloud_last_upload' ||
                    k === 'kids_trends_restore_undo') {
                    delete businessData.__localStorage__[k];
                }
            });
        }
        
        // Generate canonical sorted JSON string for stable hashing
        const canonicalStr = canonicalStringify(businessData);
        return await sha256(canonicalStr);
    } catch (e) {
        console.error('Error generating database hash:', e);
        return '';
    }
}

/**
 * CloudStorageService connected to Supabase Storage and Database Metadata
 */
const CloudStorageService = {
    /**
     * Lists the latest cloud backups (up to 5) from the database metadata table
     * @returns {Promise<Array>}
     */
    async listBackups() {
        if (!supabaseClient) {
            throw new Error('Supabase client is not initialized.');
        }
        
        const { data, error } = await supabaseClient
            .from('cloud_backups')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(5);
            
        if (error) {
            console.error('Failed to list backups from Supabase:', error);
            throw new Error(error.message);
        }
        
        return (data || []).map(row => {
            const timestampStr = row.filename.replace('backup_', '').replace('.json', ''); // e.g. "2026-07-12_14-04-57"
            return {
                filename: row.filename,
                timestamp: timestampStr,
                createdAt: row.created_at,
                size: row.size,
                hash: row.hash
            };
        });
    },

    /**
     * Uploads a new backup file to Supabase Storage and records metadata in database
     * @param {string} filename 
     * @param {string} content (JSON text)
     * @returns {Promise<object>}
     */
    async uploadBackup(filename, content) {
        if (!supabaseClient) {
            throw new Error('Supabase client is not initialized.');
        }

        const sizeBytes = new Blob([content]).size;
        
        // Calculate hash of the business data section
        const dataHash = await getDatabaseHash(content);
        
        // 1. Upload the file to Supabase Storage
        const fileBody = new Blob([content], { type: 'application/json' });
        const { data: uploadData, error: uploadError } = await supabaseClient.storage
            .from(SUPABASE_CONFIG.BUCKET)
            .upload(filename, fileBody, {
                contentType: 'application/json',
                upsert: true
            });
            
        if (uploadError) {
            console.error('Failed to upload file to Supabase Storage:', uploadError);
            throw new Error(uploadError.message);
        }
        
        // 2. Insert metadata into the database
        const { error: dbError } = await supabaseClient
            .from('cloud_backups')
            .insert([
                {
                    filename: filename,
                    hash: dataHash,
                    size: sizeBytes,
                    created_at: new Date().toISOString()
                }
            ]);
            
        if (dbError) {
            console.error('Failed to write metadata to Supabase DB:', dbError);
            // Cleanup uploaded file on DB write failure to keep state consistent
            await supabaseClient.storage.from(SUPABASE_CONFIG.BUCKET).remove([filename]);
            throw new Error(dbError.message);
        }
        
        localStorage.setItem('kids_trends_cloud_last_upload', new Date().toISOString());
        return { success: true, filename: filename };
    },

    /**
     * Downloads backup content from Supabase Storage by filename
     * @param {string} filename 
     * @returns {Promise<string>}
     */
    async downloadBackup(filename) {
        if (!supabaseClient) {
            throw new Error('Supabase client is not initialized.');
        }
        
        const { data, error } = await supabaseClient.storage
            .from(SUPABASE_CONFIG.BUCKET)
            .download(filename);
            
        if (error) {
            console.error('Failed to download file from Supabase:', error);
            throw new Error(error.message);
        }
        
        const text = await data.text();
        return text;
    },

    /**
     * Deletes the specified backup from Storage and the database metadata table
     * @param {string} filename 
     * @returns {Promise<boolean>}
     */
    async deleteBackup(filename) {
        if (!supabaseClient) {
            throw new Error('Supabase client is not initialized.');
        }
        
        // 1. Remove file from storage
        const { error: storageError } = await supabaseClient.storage
            .from(SUPABASE_CONFIG.BUCKET)
            .remove([filename]);
            
        if (storageError) {
            console.warn('Failed to remove backup from Storage, proceeding with database delete:', storageError.message);
        }
        
        // 2. Remove row from database
        const { error: dbError } = await supabaseClient
            .from('cloud_backups')
            .delete()
            .eq('filename', filename);
            
        if (dbError) {
            console.error('Failed to delete metadata from Supabase DB:', dbError);
            throw new Error(dbError.message);
        }
        
        return true;
    }
};

/**
 * Generates the current backup filename using timestamp
 */
function generateBackupFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.json`;
}

/**
 * Formats bytes to KB
 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024;
    return kb.toFixed(1) + ' KB';
}

/**
 * Formats date and time: 11/07/26 01:05 AM
 */
function formatDateTime(dateInput) {
    if (!dateInput) return 'Never';
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return 'Never';
    
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    const strHours = String(hours).padStart(2, '0');
    
    return `${day}/${month}/${year} ${strHours}:${minutes} ${ampm}`;
}

/**
 * Generates/caches current local backup JSON and updates the size, content, and hash.
 */
async function getOrGenerateLocalBackup() {
    if (state.backupDirty || !state.cachedBackupJSON) {
        const json = await exportBackupJSON();
        const size = new Blob([json]).size;
        const hash = await getDatabaseHash(json);

        state.cachedBackupJSON = json;
        state.cachedBackupSize = size;
        state.cachedBackupHash = hash;
        state.backupDirty = false;
    }
    return {
        json: state.cachedBackupJSON,
        size: state.cachedBackupSize,
        hash: state.cachedBackupHash
    };
}

/**
 * Verifies if the backup JSON contains meaningful data
 */
function verifyBackupHasMeaningfulData(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        let data = parsed.data || parsed; // support both legacy and wrapped structures
        const productsCount = (data.products || []).length;
        const billsCount = (data.bills || []).length;
        // If there are no products and no bills, it's considered empty of meaningful business data
        return (productsCount > 0 || billsCount > 0);
    } catch (e) {
        return false;
    }
}

/**
 * Updates the Cloud Backup status UI (Cloud Synced, Update Available, Empty Database)
 */
async function updateCloudBackupStatusUI() {
    const pendingStatusEl = document.getElementById('cloud-backup-pending-status');
    const lastUploadEl = document.getElementById('cloud-backup-last-upload');
    const btnUpload = document.getElementById('btn-cloud-upload-now');

    if (!pendingStatusEl || !lastUploadEl || !btnUpload) return;

    try {
        // 1. Get current backup data
        const backup = await getOrGenerateLocalBackup();
        
        // 2. Verify if it has meaningful data
        const hasData = verifyBackupHasMeaningfulData(backup.json);
        if (!hasData) {
            pendingStatusEl.innerHTML = '<span style="color: #cbd5e1; font-weight: bold;">⚪ Empty Database</span>';
            pendingStatusEl.style.backgroundColor = 'var(--text-muted)';
            btnUpload.disabled = true;
            btnUpload.style.opacity = '0.6';
            btnUpload.style.cursor = 'not-allowed';
        } else {
            // 3. Fetch cloud backup list
            const cloudBackups = await CloudStorageService.listBackups();
            
            // 4. Check if current database hash matches ANY backup in the cloud list
            const isSynced = cloudBackups.some(b => b.hash === backup.hash);

            if (isSynced) {
                pendingStatusEl.innerHTML = '<span style="color: #ffffff; font-weight: bold;">🟢 Cloud Synced</span>';
                pendingStatusEl.style.backgroundColor = 'var(--success)';
                btnUpload.disabled = true;
                btnUpload.style.opacity = '0.6';
                btnUpload.style.cursor = 'not-allowed';
            } else {
                pendingStatusEl.innerHTML = `<span style="color: #ffffff; font-weight: bold;">🟠 Update Available (${formatSize(backup.size)} Ready)</span>`;
                pendingStatusEl.style.backgroundColor = 'var(--warning)';
                btnUpload.disabled = false;
                btnUpload.style.opacity = '1';
                btnUpload.style.cursor = 'pointer';
            }
        }

        // 5. Update last upload timestamp
        const lastUploadTime = localStorage.getItem('kids_trends_cloud_last_upload');
        lastUploadEl.innerText = formatDateTime(lastUploadTime);

    } catch (e) {
        console.error('Error updating status UI:', e);
        pendingStatusEl.innerText = 'Status Error';
        pendingStatusEl.style.backgroundColor = 'var(--danger)';
    }
}

/**
 * Renders the cloud backups list table
 */
async function renderCloudBackupsTable() {
    const tbody = document.getElementById('cloud-backups-tbody');
    if (!tbody) return;

    try {
        const list = await CloudStorageService.listBackups();
        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">No cloud backups found.</td></tr>`;
            return;
        }

        tbody.innerHTML = '';
        list.slice(0, 5).forEach(backup => {
            const tr = document.createElement('tr');
            
            // Date & Time Column
            const tdDate = document.createElement('td');
            tdDate.innerText = formatDateTime(backup.createdAt);
            tr.appendChild(tdDate);

            // Size Column
            const tdSize = document.createElement('td');
            tdSize.innerText = formatSize(backup.size);
            tr.appendChild(tdSize);

            // Action Column (Restore)
            const tdAction = document.createElement('td');
            tdAction.className = 'text-center';
            const btnRestore = document.createElement('button');
            btnRestore.className = 'btn-secondary';
            btnRestore.style.padding = '4px 8px';
            btnRestore.style.fontSize = '0.75rem';
            btnRestore.style.height = 'auto';
            btnRestore.innerText = 'Restore';
            btnRestore.addEventListener('click', () => handleCloudRestoreClick(backup.filename));
            tdAction.appendChild(btnRestore);
            tr.appendChild(tdAction);

            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted" style="color: var(--danger);">Failed to load backups: ${e.message}</td></tr>`;
    }
}

/**
 * Checks for a safety rollback in IndexedDB and updates the Undo button visibility
 */
async function checkHasRollback() {
    const btnUndo = document.getElementById('btn-cloud-undo-restore');
    if (!btnUndo) return;

    try {
        const rollbackContent = await getRollbackBackup();
        if (rollbackContent) {
            btnUndo.style.display = 'flex';
        } else {
            btnUndo.style.display = 'none';
        }
    } catch (e) {
        console.error('Failed to check rollback:', e);
        btnUndo.style.display = 'none';
    }
}

/**
 * Opens the cloud backup panel
 */
async function openCloudBackupPanel() {
    // Hide password modals if open
    closeCloudPasswordModal();
    closeCloudForgotPasswordModal();

    // Show the cloud backup panel modal
    const panelModal = document.getElementById('cloud-backup-panel-modal');
    if (panelModal) {
        panelModal.style.display = 'flex';
    }
    
    // Refresh the contents
    await updateCloudBackupStatusUI();
    await renderCloudBackupsTable();
    await checkHasRollback();
}

/**
 * Hides all cloud-related modals
 */
function closeCloudPasswordModal() {
    const modal = document.getElementById('cloud-password-modal');
    if (modal) modal.style.display = 'none';
    const input = document.getElementById('cloud-password-input');
    if (input) input.value = '';
    const err = document.getElementById('cloud-password-prompt-error');
    if (err) err.style.display = 'none';
}

function closeCloudForgotPasswordModal() {
    const modal = document.getElementById('cloud-forgot-password-modal');
    if (modal) modal.style.display = 'none';
    
    const recInput = document.getElementById('cloud-recovery-code-input');
    if (recInput) recInput.value = '';
    
    const npInput = document.getElementById('cloud-recovery-new-pw');
    if (npInput) npInput.value = '';
    
    const cpInput = document.getElementById('cloud-recovery-confirm-pw');
    if (cpInput) cpInput.value = '';
    
    const err = document.getElementById('cloud-recovery-error');
    if (err) err.style.display = 'none';
    
    const pwErr = document.getElementById('cloud-recovery-pw-error');
    if (pwErr) pwErr.style.display = 'none';
    
    const step1 = document.getElementById('cloud-recovery-step-1-form');
    if (step1) step1.style.display = 'grid';
    
    const step2 = document.getElementById('cloud-recovery-step-2-form');
    if (step2) step2.style.display = 'none';
}

function closeCloudBackupPanelModal() {
    const modal = document.getElementById('cloud-backup-panel-modal');
    if (modal) modal.style.display = 'none';
    
    // Clear forms inside it
    const oInput = document.getElementById('cloud-pw-old');
    if (oInput) oInput.value = '';
    
    const nInput = document.getElementById('cloud-pw-new');
    if (nInput) nInput.value = '';
    
    const cInput = document.getElementById('cloud-pw-confirm');
    if (cInput) cInput.value = '';
    
    const err = document.getElementById('cloud-change-pw-error');
    if (err) err.style.display = 'none';
}

/**
 * Submits the verification password form
 */
async function handleCloudPasswordSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('cloud-password-input');
    const errorDiv = document.getElementById('cloud-password-prompt-error');
    if (!input || !errorDiv) return;

    errorDiv.style.display = 'none';

    try {
        const hash = await sha256(input.value.trim());
        const storedHash = await getSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);

        if (hash === storedHash) {
            openCloudBackupPanel();
        } else {
            errorDiv.style.display = 'block';
            input.value = '';
            input.focus();
        }
    } catch (e) {
        showToast('Security verification failed: ' + e.message, 'error');
    }
}

/**
 * Submits Change Password form
 */
async function handleCloudChangePWSubmit(event) {
    event.preventDefault();
    const oldPW = document.getElementById('cloud-pw-old').value.trim();
    const newPW = document.getElementById('cloud-pw-new').value.trim();
    const confirmPW = document.getElementById('cloud-pw-confirm').value.trim();
    const errorDiv = document.getElementById('cloud-change-pw-error');

    if (errorDiv) errorDiv.style.display = 'none';

    if (!oldPW || !newPW || !confirmPW) {
        showToast('Please fill all password fields.', 'warning');
        return;
    }

    if (newPW !== confirmPW) {
        if (errorDiv) {
            errorDiv.innerText = 'New passwords do not match.';
            errorDiv.style.display = 'block';
        }
        return;
    }

    try {
        const storedHash = await getSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);
        const oldHash = await sha256(oldPW);

        if (oldHash !== storedHash) {
            if (errorDiv) {
                errorDiv.innerText = 'Incorrect current password.';
                errorDiv.style.display = 'block';
            }
            return;
        }

        const newHash = await sha256(newPW);
        await setSetting('cloud_backup_pin_hash', newHash);
        showToast('Cloud password updated successfully!', 'success');
        await logActivity('Cloud PW Changed', 'Cloud Backup security password updated');
        
        // Reset inputs
        document.getElementById('cloud-pw-old').value = '';
        document.getElementById('cloud-pw-new').value = '';
        document.getElementById('cloud-pw-confirm').value = '';
    } catch (e) {
        showToast('Change password failed: ' + e.message, 'error');
    }
}

/**
 * Handles forgot password recovery code verification
 */
function handleCloudRecoveryStep1Submit(event) {
    event.preventDefault();
    const input = document.getElementById('cloud-recovery-code-input');
    const errorDiv = document.getElementById('cloud-recovery-error');
    
    if (errorDiv) errorDiv.style.display = 'none';

    if (input && input.value.trim() === 'Recover@1') {
        document.getElementById('cloud-recovery-step-1-form').style.display = 'none';
        document.getElementById('cloud-recovery-step-2-form').style.display = 'grid';
        const newPWInput = document.getElementById('cloud-recovery-new-pw');
        if (newPWInput) newPWInput.focus();
    } else {
        if (errorDiv) errorDiv.style.display = 'block';
    }
}

/**
 * Handles forgot password new password submission
 */
async function handleCloudRecoveryStep2Submit(event) {
    event.preventDefault();
    const newPW = document.getElementById('cloud-recovery-new-pw').value.trim();
    const confirmPW = document.getElementById('cloud-recovery-confirm-pw').value.trim();
    const errorDiv = document.getElementById('cloud-recovery-pw-error');

    if (errorDiv) errorDiv.style.display = 'none';

    if (!newPW || !confirmPW) {
        if (errorDiv) {
            errorDiv.innerText = 'Passwords cannot be empty.';
            errorDiv.style.display = 'block';
        }
        return;
    }

    if (newPW !== confirmPW) {
        if (errorDiv) {
            errorDiv.innerText = 'Passwords do not match.';
            errorDiv.style.display = 'block';
        }
        return;
    }

    try {
        const newHash = await sha256(newPW);
        await setSetting('cloud_backup_pin_hash', newHash);
        await logActivity('Cloud PW Recovered', 'Cloud password reset using Recovery Code');
        showToast('Cloud password reset successfully!', 'success');
        
        // Open the panel
        openCloudBackupPanel();
    } catch (e) {
        showToast('Password recovery failed: ' + e.message, 'error');
    }
}

/**
 * Handles Cloud "Update Now" click
 */
async function handleCloudUploadNowClick() {
    const promptPassword = prompt('Enter Cloud Password to verify backup upload:');
    if (!promptPassword) return;

    let logIds = [];
    try {
        const passwordHash = await sha256(promptPassword.trim());
        const storedHash = await getSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);
        if (passwordHash !== storedHash) {
            showToast('Incorrect Cloud Password. Upload cancelled.', 'error');
            return;
        }

        if (confirm('Upload latest backup to Cloud? If Cloud already contains 5 backups, the oldest backup will be removed after successful upload.')) {
            const btnUpload = document.getElementById('btn-cloud-upload-now');
            if (btnUpload) {
                btnUpload.disabled = true;
                btnUpload.innerText = 'Uploading... ⏳';
            }

            // 1. Get current cloud backup list to check if we will exceed the limit of 5
            const cloudBackups = await CloudStorageService.listBackups();
            const willRotate = cloudBackups.length >= 5;
            
            // 2. Add log entries to IndexedDB BEFORE exporting, so they are part of the uploaded backup.
            // This guarantees local and cloud hashes match!
            if (willRotate) {
                const oldest = cloudBackups[cloudBackups.length - 1];
                const rotateLogId = await logActivity('Cloud Backup Rotated', `Deleted oldest backup: ${oldest.filename}`);
                logIds.push(rotateLogId);
            }
            const filename = generateBackupFilename();
            const saveLogId = await logActivity('Cloud Backup Saved', `File: ${filename}`);
            logIds.push(saveLogId);
            
            // Mark dirty so the JSON gets regenerated containing these new logs
            markBackupDirty();

            // A. Generate JSON
            const backup = await getOrGenerateLocalBackup();

            // B. Verify JSON has meaningful data
            const hasData = verifyBackupHasMeaningfulData(backup.json);
            if (!hasData) {
                showToast('Upload failed: Database contains no meaningful data.', 'error');
                // Rollback the logs we added
                for (const id of logIds) {
                    await deleteAuditLog(id);
                }
                logIds = [];
                markBackupDirty();
                if (btnUpload) {
                    btnUpload.disabled = false;
                    btnUpload.innerText = 'Update Now 📤';
                }
                return;
            }

            // C. Upload
            const result = await CloudStorageService.uploadBackup(filename, backup.json);

            // D. Verify success
            if (result && result.success) {
                showToast('Backup successfully uploaded to Cloud!', 'success');

                // E. If we rotated, delete the oldest backup from simulated storage
                if (willRotate) {
                    const oldest = cloudBackups[cloudBackups.length - 1];
                    await CloudStorageService.deleteBackup(oldest.filename);
                }

                // F. Refresh Backup List and UI status
                await updateCloudBackupStatusUI();
                await renderCloudBackupsTable();
            } else {
                showToast('Upload verification failed.', 'error');
                // Rollback logs on failure
                for (const id of logIds) {
                    await deleteAuditLog(id);
                }
                logIds = [];
                markBackupDirty();
            }

            if (btnUpload) {
                btnUpload.disabled = false;
                btnUpload.innerText = 'Update Now 📤';
            }
        }
    } catch (e) {
        showToast('Upload failed: ' + e.message, 'error');
        // Rollback logs on failure
        for (const id of logIds) {
            try {
                await deleteAuditLog(id);
            } catch (deleteErr) {
                console.error('Failed to clean up log:', deleteErr);
            }
        }
        markBackupDirty();
        const btnUpload = document.getElementById('btn-cloud-upload-now');
        if (btnUpload) {
            btnUpload.disabled = false;
            btnUpload.innerText = 'Update Now 📤';
        }
    }
}

/**
 * Handles Restore backup click
 */
async function handleCloudRestoreClick(filename) {
    const promptPassword = prompt('Enter Cloud Password to authorize database restore:');
    if (!promptPassword) return;

    try {
        const passwordHash = await sha256(promptPassword.trim());
        const storedHash = await getSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);
        if (passwordHash !== storedHash) {
            showToast('Incorrect Cloud Password. Restore cancelled.', 'error');
            return;
        }

        if (confirm('Restore this backup? Current local data will be replaced.')) {
            // A. Create safety rollback backup in IndexedDB
            const currentBackupJSON = await exportBackupJSON();
            await saveRollbackBackup(currentBackupJSON);
            await logActivity('Safety Rollback Created', 'Temporary backup created before restoring cloud version');

            // B. Download backup from cloud
            const content = await CloudStorageService.downloadBackup(filename);

            // C. Import / Apply it
            await restoreBackupJSON(content);
            
            showToast('Database successfully restored from Cloud! Reloading...', 'success');
            await logActivity('Cloud Backup Restored', `Restored file: ${filename}`);

            setTimeout(() => {
                window.location.reload();
            }, 1500);
        }
    } catch (e) {
        showToast('Restore failed: ' + e.message, 'error');
    }
}

/**
 * Handles Rollback undo restore action
 */
async function handleCloudUndoRestoreClick() {
    const promptPassword = prompt('Enter Cloud Password to authorize Undo Restore:');
    if (!promptPassword) return;

    try {
        const passwordHash = await sha256(promptPassword.trim());
        const storedHash = await getSetting('cloud_backup_pin_hash', DEFAULT_PIN_HASH);
        if (passwordHash !== storedHash) {
            showToast('Incorrect Cloud Password. Undo cancelled.', 'error');
            return;
        }

        if (confirm('Are you sure you want to undo the last restore? This will revert the database to the exact state before the restore.')) {
            const rollbackContent = await getRollbackBackup();
            if (!rollbackContent) {
                showToast('Undo failed: No rollback backup found.', 'error');
                return;
            }

            // Restore the rollback
            await restoreBackupJSON(rollbackContent);
            
            // Clear the rollback
            await clearRollbackBackup();

            showToast('Database successfully reverted to pre-restore state! Reloading...', 'success');
            await logActivity('Restore Rolled Back', 'Database reverted using safety undo rollback');

            setTimeout(() => {
                window.location.reload();
            }, 1500);
        }
    } catch (e) {
        showToast('Undo failed: ' + e.message, 'error');
    }
}
