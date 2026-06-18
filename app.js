// KID'S TRENDS POS - APPLICATION LOGIC

// ==========================================
// STATE MANAGEMENT
// ==========================================
const state = {
    cart: [],
    discountType: 'percentage', // 'percentage' | 'fixed'
    discountValue: 0,
    gstPercent: 0,
    currentSection: 'home',
    adminUnlocked: false,
    adminTab: 'analytics',
    allProducts: [],
    searchResults: [],
    activeBill: null
};

// Default hashed PIN for ABCD1234
const DEFAULT_PIN_HASH = '1635c8525afbae58c37bede3c9440844e9143727cc7c160bed665ec378d8a262';

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize IndexedDB
    try {
        await initDB();
        
        // Seed default products if empty
        await seedDefaultProducts();
        
        // Ensure default PIN is seeded in Settings
        const storedPinHash = await getSetting('admin_pin_hash');
        if (!storedPinHash) {
            await setSetting('admin_pin_hash', DEFAULT_PIN_HASH);
        }
        
        // Load products into memory for quick searches (<50ms target)
        await refreshProductsCache();
        
        // Initialize UI
        setupEventListeners();
        switchSection('home');
        await updateHomeDashboard();
        
    } catch (err) {
        console.error('Failed to initialize application:', err);
        showToast('Database Error: ' + err.message, 'error');
    }
});

/**
 * Refreshes the memory cache of products for super fast searching.
 */
async function refreshProductsCache() {
    state.allProducts = await getAllProducts();
}

// ==========================================
// ROUTING & NAVIGATION
// ==========================================
function switchSection(sectionId) {
    state.currentSection = sectionId;
    
    // Toggle active classes on sections
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
    });
    
    const targetSection = document.getElementById(`${sectionId}-section`);
    if (targetSection) {
        targetSection.classList.add('active');
    }

    // Toggle bottom nav highlights
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    const targetNavItem = document.getElementById(`nav-${sectionId}`);
    if (targetNavItem) {
        targetNavItem.classList.add('active');
    }

    // Tab-specific loading
    if (sectionId === 'home') {
        updateHomeDashboard();
    } else if (sectionId === 'bill') {
        renderCart();
        focusSearch();
    } else if (sectionId === 'admin') {
        renderAdminView();
    }
}

function renderAdminView() {
    const adminContent = document.getElementById('admin-content');
    const adminLogin = document.getElementById('admin-login');

    if (state.adminUnlocked) {
        adminLogin.style.display = 'none';
        adminContent.style.display = 'block';
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
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.admin-tab-content').forEach(content => {
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
// SEARCH & AUTOCOMPLETE
// ==========================================
function handleSearchInput(query) {
    const suggestionsBox = document.getElementById('search-suggestions');
    if (!query.trim()) {
        suggestionsBox.innerHTML = '';
        suggestionsBox.style.display = 'none';
        return;
    }

    const cleanQuery = query.toLowerCase();
    
    // Filter from local products cache (< 1ms search time)
    const matches = state.allProducts.filter(p => 
        p.code.toLowerCase().includes(cleanQuery) || 
        p.name.toLowerCase().includes(cleanQuery) ||
        p.category.toLowerCase().includes(cleanQuery)
    );

    if (matches.length === 0) {
        suggestionsBox.innerHTML = '<div class="suggestion-item no-match">No products found</div>';
        suggestionsBox.style.display = 'block';
        return;
    }

    // Limit to top 5 suggestions for speed and space
    const listHtml = matches.slice(0, 5).map(p => `
        <div class="suggestion-item" onclick="addProductToCartByCode('${p.code}')">
            <div class="suggest-details">
                <span class="suggest-name">${p.name}</span>
                <span class="suggest-code">${p.code} | Stock: ${p.stock}</span>
            </div>
            <span class="suggest-price">₹${p.price}</span>
        </div>
    `).join('');

    suggestionsBox.innerHTML = listHtml;
    suggestionsBox.style.display = 'block';
}

function addProductToCartByCode(code) {
    const product = state.allProducts.find(p => p.code === code);
    if (!product) {
        showToast('Product code not found', 'error');
        return;
    }

    if (product.stock <= 0) {
        showToast(`OUT OF STOCK: ${product.name}`, 'error');
        return;
    }

    const existingCartItem = state.cart.find(item => item.code === code);
    if (existingCartItem) {
        if (existingCartItem.qty >= product.stock) {
            showToast(`Cannot add. Stock limit reached (${product.stock} units)`, 'warning');
            return;
        }
        existingCartItem.qty += 1;
    } else {
        state.cart.push({
            code: product.code,
            name: product.name,
            category: product.category,
            price: product.price,
            stock: product.stock,
            qty: 1
        });
    }

    // Clear search
    document.getElementById('billing-search').value = '';
    document.getElementById('search-suggestions').style.display = 'none';
    
    renderCart();
    playBeepSound();
}

// ==========================================
// CART & BILLING CONTROLS
// ==========================================
function updateQuantity(code, delta) {
    const item = state.cart.find(i => i.code === code);
    if (!item) return;

    const newQty = item.qty + delta;
    if (newQty <= 0) {
        // Remove item
        state.cart = state.cart.filter(i => i.code !== code);
    } else {
        // Check stock limit
        if (newQty > item.stock) {
            showToast(`Only ${item.stock} units available in stock.`, 'warning');
            return;
        }
        item.qty = newQty;
    }
    renderCart();
}

function removeItemFromCart(code) {
    state.cart = state.cart.filter(i => i.code !== code);
    renderCart();
}

function renderCart() {
    const cartTbody = document.getElementById('cart-tbody');
    const checkoutBtn = document.getElementById('btn-checkout');

    if (state.cart.length === 0) {
        cartTbody.innerHTML = `
            <tr>
                <td colspan="4" class="empty-cart-row">
                    <div class="empty-cart-message">
                        🛒 Cart is empty. Search products below or scan code to add items.
                    </div>
                </td>
            </tr>
        `;
        checkoutBtn.disabled = true;
        updateTotalsDisplay(0, 0, 0, 0, 0);
        return;
    }

    checkoutBtn.disabled = false;
    
    let subtotal = 0;
    cartTbody.innerHTML = state.cart.map(item => {
        const itemTotal = item.price * item.qty;
        subtotal += itemTotal;
        return `
            <tr>
                <td>
                    <div class="cart-prod-title">${item.name}</div>
                    <div class="cart-prod-sub">${item.code}</div>
                </td>
                <td class="text-right">₹${item.price}</td>
                <td>
                    <div class="qty-control">
                        <button type="button" class="qty-btn" onclick="updateQuantity('${item.code}', -1)">-</button>
                        <span class="qty-val">${item.qty}</span>
                        <button type="button" class="qty-btn" onclick="updateQuantity('${item.code}', 1)">+</button>
                    </div>
                </td>
                <td class="text-right font-medium">₹${itemTotal}</td>
                <td class="text-center">
                    <button type="button" class="cart-remove-btn" onclick="removeItemFromCart('${item.code}')">&times;</button>
                </td>
            </tr>
        `;
    }).join('');

    calculateCartTotals(subtotal);
}

function calculateCartTotals(subtotal) {
    // 1. Calculate discount
    let discountAmount = 0;
    if (state.discountType === 'percentage') {
        discountAmount = Math.round((subtotal * (state.discountValue / 100)) * 100) / 100;
    } else if (state.discountType === 'fixed') {
        discountAmount = Math.min(state.discountValue, subtotal);
    }

    // 2. Calculate taxable amount
    const taxableAmount = subtotal - discountAmount;

    // 3. Calculate GST
    const gstAmount = state.gstPercent > 0 ? Math.round((taxableAmount * (state.gstPercent / 100)) * 100) / 100 : 0;

    // 4. Calculate Grand Total
    const grandTotal = Math.round((taxableAmount + gstAmount) * 100) / 100;

    const itemsCount = state.cart.reduce((sum, item) => sum + item.qty, 0);

    updateTotalsDisplay(itemsCount, subtotal, discountAmount, gstAmount, grandTotal);
}

function updateTotalsDisplay(itemsCount, subtotal, discount, gst, grandTotal) {
    document.getElementById('summary-items').innerText = itemsCount;
    document.getElementById('summary-subtotal').innerText = `₹${subtotal.toFixed(2)}`;
    document.getElementById('summary-discount').innerText = `₹${discount.toFixed(2)}`;
    
    // GST row conditional display logic
    const gstRow = document.getElementById('summary-gst-row');
    if (state.gstPercent > 0) {
        gstRow.style.display = 'flex';
        document.getElementById('summary-gst-label').innerText = `GST (${state.gstPercent}%):`;
        document.getElementById('summary-gst').innerText = `₹${gst.toFixed(2)}`;
    } else {
        gstRow.style.display = 'none';
    }

    document.getElementById('summary-total').innerText = `₹${grandTotal.toFixed(2)}`;
}

// ==========================================
// CHECKOUT & PRINTING
// ==========================================
async function handleCheckout() {
    if (state.cart.length === 0) return;

    const checkoutBtn = document.getElementById('btn-checkout');
    checkoutBtn.disabled = true;
    checkoutBtn.innerText = 'Processing...';

    try {
        // Run atomic billing transaction
        const billRecord = await createBill(state.cart, {
            type: state.discountType,
            value: state.discountValue
        }, state.gstPercent);

        showToast(`Checkout complete. Bill ${billRecord.id} generated!`, 'success');
        
        // Refresh local cache and home dashboard
        await refreshProductsCache();
        await updateHomeDashboard();
        
        // Clear cart
        state.cart = [];
        resetBillingInputs();

        // Render receipt view and show print modal
        showReceiptModal(billRecord);
        
    } catch (err) {
        showToast(err.message, 'error');
        checkoutBtn.disabled = false;
        checkoutBtn.innerText = 'Proceed Checkout';
    }
}

function resetBillingInputs() {
    state.discountValue = 0;
    state.gstPercent = 0;
    
    document.getElementById('billing-discount-value').value = 0;
    document.getElementById('billing-gst-percent').value = 0;
    document.getElementById('billing-search').value = '';
    
    renderCart();
}

function showReceiptModal(bill) {
    state.activeBill = bill;
    
    // Assemble receipt HTML formatted specifically for 80mm receipt style
    const receiptHtml = `
<div class="receipt-header">
    <h2>KID'S TRENDS</h2>
    <div class="receipt-sub">A Complete Kids Wear Collection</div>
    <div>Near Siddiq Shah Taleem</div>
    <div>Choubara Road, Bidar</div>
    <div>Phone: +91 8453554561</div>
</div>
<hr class="receipt-divider">
<div class="receipt-meta">
    <div><strong>Bill No:</strong> ${bill.id}</div>
    <div><strong>Date:</strong> ${bill.date}</div>
    <div><strong>Time:</strong> ${bill.time}</div>
</div>
<hr class="receipt-divider">
<table class="receipt-table">
    <thead>
        <tr>
            <th>Product</th>
            <th class="text-right">Price</th>
            <th class="text-center">Qty</th>
            <th class="text-right">Total</th>
        </tr>
    </thead>
    <tbody>
        ${bill.items.map(item => `
            <tr>
                <td>${item.name}</td>
                <td class="text-right">₹${item.price}</td>
                <td class="text-center">${item.qty}</td>
                <td class="text-right">₹${item.total}</td>
            </tr>
        `).join('')}
    </tbody>
</table>
<hr class="receipt-divider">
<div class="receipt-totals">
    <div class="receipt-total-row">
        <span>Subtotal:</span>
        <span>₹${bill.subtotal.toFixed(2)}</span>
    </div>
    <div class="receipt-total-row">
        <span>Discount:</span>
        <span>₹${bill.discountAmount.toFixed(2)}</span>
    </div>
    ${bill.gstPercent > 0 ? `
    <div class="receipt-total-row">
        <span>GST (${bill.gstPercent}%):</span>
        <span>₹${bill.gstAmount.toFixed(2)}</span>
    </div>
    ` : ''}
    <hr class="receipt-divider">
    <div class="receipt-total-row grand-total">
        <span>Grand Total:</span>
        <span>₹${bill.grandTotal.toFixed(2)}</span>
    </div>
</div>
<hr class="receipt-divider">
<div class="receipt-footer">
    THANK YOU - VISIT AGAIN
</div>
    `;

    document.getElementById('receipt-modal-body').innerHTML = receiptHtml;
    
    // Set up hidden receipt container for printing
    document.getElementById('receipt-print-area').innerHTML = receiptHtml;
    
    // Open receipt modal
    document.getElementById('receipt-modal').style.display = 'flex';
}

function closeReceiptModal() {
    document.getElementById('receipt-modal').style.display = 'none';
    document.getElementById('receipt-print-area').innerHTML = '';
    state.activeBill = null;
    switchSection('bill');
}

function printActiveReceipt() {
    window.print();
}

// ==========================================
// HOME DASHBOARD
// ==========================================
async function updateHomeDashboard() {
    const bills = await getAllBills();
    
    // Get today's range
    const now = new Date();
    const todayStr = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;

    // Filter today's bills
    const todayBills = bills.filter(b => b.date === todayStr);

    let todayRevenue = 0;
    let todayProductsSold = 0;
    todayBills.forEach(b => {
        todayRevenue += b.grandTotal;
        b.items.forEach(item => {
            todayProductsSold += item.qty;
        });
    });

    // Update stats UI
    document.getElementById('stat-revenue').innerText = `₹${todayRevenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('stat-bills').innerText = todayBills.length;
    document.getElementById('stat-items').innerText = todayProductsSold;

    // Render Recent Bills (up to 5)
    const recentBillsList = document.getElementById('recent-transactions-list');
    if (bills.length === 0) {
        recentBillsList.innerHTML = '<div class="no-recent">No transactions logged yet.</div>';
        return;
    }

    recentBillsList.innerHTML = bills.slice(0, 5).map(b => `
        <div class="transaction-item" onclick="viewBillDetails('${b.id}')">
            <div class="trans-details">
                <div class="trans-id">${b.id}</div>
                <div class="trans-meta">${b.time} | ${b.items.length} items</div>
            </div>
            <div class="trans-amount">₹${b.grandTotal.toFixed(2)}</div>
        </div>
    `).join('');
}

async function viewBillDetails(billId) {
    const bill = await getBill(billId);
    if (!bill) {
        showToast('Bill not found', 'error');
        return;
    }
    showReceiptModal(bill);
}

// ==========================================
// CAMERA SCANNER OVERLAY
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
            // Success handler
            addProductToCartByCode(scannedCode);
            closeScannerOverlay();
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

// ==========================================
// ADMIN PIN SECURITY
// ==========================================
// Managed via form submission. Helper function to lock admin.

function lockAdmin() {
    state.adminUnlocked = false;
    showToast('Admin logged out', 'info');
    renderAdminView();
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// ==========================================
// ADMIN: ANALYTICS TAB
// ==========================================
async function loadAnalytics(rangeType) {
    // Set active style on filter button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === rangeType);
    });

    const customFields = document.getElementById('custom-date-fields');
    if (rangeType === 'custom') {
        customFields.style.display = 'flex';
    } else {
        customFields.style.display = 'none';
    }

    const bills = await getAllBills();
    let filteredBills = [];

    const now = new Date();
    
    // Get date strings for comparisons
    const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    if (rangeType === 'today') {
        filteredBills = bills.filter(b => {
            const bDate = new Date(b.dateTimestamp);
            return bDate >= todayDate;
        });
    } else if (rangeType === 'yesterday') {
        const yesterdayDate = new Date(todayDate);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        filteredBills = bills.filter(b => {
            const bDate = new Date(b.dateTimestamp);
            return bDate >= yesterdayDate && bDate < todayDate;
        });
    } else if (rangeType === '7days') {
        const sevenDaysAgo = new Date(todayDate);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        filteredBills = bills.filter(b => new Date(b.dateTimestamp) >= sevenDaysAgo);
    } else if (rangeType === '30days') {
        const thirtyDaysAgo = new Date(todayDate);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        filteredBills = bills.filter(b => new Date(b.dateTimestamp) >= thirtyDaysAgo);
    } else if (rangeType === 'custom') {
        const startVal = document.getElementById('analytics-start-date').value;
        const endVal = document.getElementById('analytics-end-date').value;
        if (!startVal || !endVal) {
            filteredBills = [];
        } else {
            const startDate = new Date(startVal);
            const endDate = new Date(endVal);
            endDate.setHours(23, 59, 59, 999); // Include entire end day
            filteredBills = bills.filter(b => {
                const ts = b.dateTimestamp;
                return ts >= startDate.getTime() && ts <= endDate.getTime();
            });
        }
    }

    // Compile reports metrics
    let revenue = 0;
    let productsSold = 0;
    const itemMap = {}; // name -> { code, qty, revenue }

    filteredBills.forEach(b => {
        revenue += b.grandTotal;
        b.items.forEach(item => {
            productsSold += item.qty;
            if (!itemMap[item.name]) {
                itemMap[item.name] = { code: item.code, qty: 0, revenue: 0 };
            }
            itemMap[item.name].qty += item.qty;
            itemMap[item.name].revenue += item.total;
        });
    });

    const averageOrder = filteredBills.length > 0 ? (revenue / filteredBills.length) : 0;

    // Render summary numbers
    document.getElementById('report-revenue').innerText = `₹${revenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    document.getElementById('report-bills').innerText = filteredBills.length;
    document.getElementById('report-items').innerText = productsSold;
    document.getElementById('report-aov').innerText = `₹${averageOrder.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

    // Top products calculation
    const topProducts = Object.keys(itemMap).map(name => ({
        name,
        code: itemMap[name].code,
        qty: itemMap[name].qty,
        revenue: itemMap[name].revenue
    }));
    topProducts.sort((a, b) => b.qty - a.qty);

    const topTbody = document.getElementById('report-top-products');
    if (topProducts.length === 0) {
        topTbody.innerHTML = '<tr><td colspan="4" class="text-center pad-y-md text-muted">No products sold in this period.</td></tr>';
    } else {
        topTbody.innerHTML = topProducts.slice(0, 5).map((p, idx) => `
            <tr>
                <td class="text-center font-medium">${idx + 1}</td>
                <td>
                    <div class="cart-prod-title">${p.name}</div>
                    <div class="cart-prod-sub">${p.code}</div>
                </td>
                <td class="text-center font-medium">${p.qty}</td>
                <td class="text-right font-medium">₹${p.revenue.toFixed(2)}</td>
            </tr>
        `).join('');
    }

    // Render simple, premium SVG trend chart
    renderRevenueSVGChart(filteredBills, rangeType);
}

function renderRevenueSVGChart(bills, rangeType) {
    const chartContainer = document.getElementById('report-chart-container');
    chartContainer.innerHTML = '';

    if (bills.length === 0) {
        chartContainer.innerHTML = '<div class="chart-empty">No sales data available for chart.</div>';
        return;
    }

    // Group sales by day/date
    const dailySales = {};
    bills.forEach(b => {
        // b.date is "DD-MM-YYYY"
        if (!dailySales[b.date]) {
            dailySales[b.date] = { date: b.date, revenue: 0, timestamp: b.dateTimestamp };
        }
        dailySales[b.date].revenue += b.grandTotal;
    });

    const dataPoints = Object.values(dailySales);
    // Sort chronological
    dataPoints.sort((a, b) => a.timestamp - b.timestamp);

    // If only 1 data point, let's create a dummy visual bar
    const maxRevenue = Math.max(...dataPoints.map(d => d.revenue), 100);

    // Render SVG
    const width = 600;
    const height = 180;
    const padding = 30;
    const chartWidth = width - (padding * 2);
    const chartHeight = height - (padding * 2);

    let barsHtml = '';
    const barWidth = Math.max((chartWidth / dataPoints.length) - 10, 5);
    const spacing = (chartWidth - (barWidth * dataPoints.length)) / (dataPoints.length > 1 ? (dataPoints.length - 1) : 1);

    dataPoints.forEach((d, idx) => {
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

    const svg = `
        <svg viewBox="0 0 ${width} ${height}" class="sales-chart-svg">
            <defs>
                <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent-primary)" />
                    <stop offset="100%" stop-color="var(--accent-secondary)" />
                </linearGradient>
            </defs>
            <!-- Grid Lines -->
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border-color)" stroke-width="1" />
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="var(--border-color)" stroke-dasharray="4" stroke-width="1" />
            
            ${barsHtml}
        </svg>
    `;

    chartContainer.innerHTML = svg;
}

// ==========================================
// ADMIN: INVENTORY TAB
// ==========================================
let editingProductCode = null;

async function renderInventoryList() {
    const products = await getAllProducts();
    const query = document.getElementById('inventory-search').value.toLowerCase().trim();

    const filtered = products.filter(p => 
        p.code.toLowerCase().includes(query) || 
        p.name.toLowerCase().includes(query) ||
        p.category.toLowerCase().includes(query)
    );

    const tbody = document.getElementById('inventory-tbody');
    
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center pad-y-md text-muted">No products in inventory match description.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(p => `
        <tr class="${p.stock === 0 ? 'stock-out-row' : (p.stock <= 5 ? 'stock-low-row' : '')}">
            <td class="font-medium">${p.code}</td>
            <td>${p.name}</td>
            <td>${p.category}</td>
            <td class="text-right">₹${p.price}</td>
            <td class="text-center">
                <span class="stock-badge ${p.stock === 0 ? 'badge-out' : (p.stock <= 5 ? 'badge-low' : 'badge-normal')}">
                    ${p.stock} units
                </span>
            </td>
            <td class="text-center">
                <div class="actions-group">
                    <button class="btn-action edit" onclick="openProductEditModal('${p.code}')">Edit</button>
                    <button class="btn-action delete" onclick="handleDeleteProduct('${p.code}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openProductAddModal() {
    editingProductCode = null;
    document.getElementById('product-modal-title').innerText = 'Add New Product';
    
    // Clear form
    document.getElementById('prod-code').value = '';
    document.getElementById('prod-code').disabled = false;
    document.getElementById('prod-name').value = '';
    document.getElementById('prod-category').value = '';
    document.getElementById('prod-price').value = '';
    document.getElementById('prod-stock').value = '';
    
    document.getElementById('product-modal').style.display = 'flex';
}

async function openProductEditModal(code) {
    const product = await getProduct(code);
    if (!product) return;

    editingProductCode = code;
    document.getElementById('product-modal-title').innerText = 'Edit Product';
    
    // Fill form
    document.getElementById('prod-code').value = product.code;
    document.getElementById('prod-code').disabled = true; // Cannot edit code (primary key)
    document.getElementById('prod-name').value = product.name;
    document.getElementById('prod-category').value = product.category;
    document.getElementById('prod-price').value = product.price;
    document.getElementById('prod-stock').value = product.stock;

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
    const price = parseFloat(document.getElementById('prod-price').value);
    const stock = parseInt(document.getElementById('prod-stock').value);

    if (!code || !name || !category || isNaN(price) || isNaN(stock)) {
        showToast('Please fill all form fields correctly.', 'warning');
        return;
    }

    // If new product, verify code doesn't exist
    if (editingProductCode === null) {
        const existing = await getProduct(code);
        if (existing) {
            showToast(`Product code ${code} already exists in database.`, 'error');
            return;
        }
    }

    try {
        await saveProduct({ code, name, category, price, stock });
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
    const bills = await getAllBills();
    const query = document.getElementById('bills-search').value.toLowerCase().trim();

    const filtered = bills.filter(b => 
        b.id.toLowerCase().includes(query) || 
        b.date.includes(query)
    );

    const tbody = document.getElementById('bills-tbody');
    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center pad-y-md text-muted">No matching transactions.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(b => `
        <tr>
            <td class="font-medium">${b.id}</td>
            <td>${b.date} <span class="text-muted text-sm">${b.time}</span></td>
            <td class="text-center font-medium">${b.items.length} items</td>
            <td class="text-right font-medium">₹${b.grandTotal.toFixed(2)}</td>
            <td class="text-center">
                <div class="actions-group">
                    <button class="btn-action view" onclick="viewBillDetails('${b.id}')">View</button>
                    <button class="btn-action delete" onclick="promptDeleteBill('${b.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
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
// ADMIN: SETTINGS, BACKUP & RESTORE TAB
// ==========================================
async function loadSettingsTab() {
    // Audit logs render
    const logs = await getAuditLogs();
    const logTbody = document.getElementById('audit-logs-tbody');

    if (logs.length === 0) {
        logTbody.innerHTML = '<tr><td colspan="3" class="text-center pad-y-sm text-muted">No actions recorded.</td></tr>';
    } else {
        logTbody.innerHTML = logs.slice(0, 25).map(l => {
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
            if (confirm('Restoring will overwrite all existing local database entries. Do you wish to proceed?')) {
                await restoreBackupJSON(result);
                showToast('Database restored successfully! Reloading page...', 'success');
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
        showToast('Please enter PIN details.', 'warning');
        return;
    }

    if (newPin.length < 4 || newPin.length > 8) {
        showToast('New PIN must be between 4 and 8 digits.', 'warning');
        return;
    }

    if (newPin !== confirmPin) {
        showToast('New PIN verification mismatch.', 'error');
        return;
    }

    try {
        const storedHash = await getSetting('admin_pin_hash', DEFAULT_PIN_HASH);
        const oldHash = await sha256(oldPin);

        if (oldHash !== storedHash) {
            showToast('Incorrect old PIN entered.', 'error');
            return;
        }

        const newHash = await sha256(newPin);
        await setSetting('admin_pin_hash', newHash);
        showToast('PIN code updated successfully!', 'success');
        
        // Clear forms
        document.getElementById('pin-old').value = '';
        document.getElementById('pin-new').value = '';
        document.getElementById('pin-confirm').value = '';

        await logActivity('Admin PIN Changed', 'Hashed administrative PIN code updated');

    } catch (e) {
        showToast('PIN change failed: ' + e.message, 'error');
    }
}

async function handleFactoryReset() {
    const pin = prompt('Please enter the current Admin PIN code to confirm Factory Reset:');
    if (!pin) return;

    try {
        const hash = await sha256(pin);
        const storedHash = await getSetting('admin_pin_hash', DEFAULT_PIN_HASH);

        if (hash !== storedHash) {
            showToast('Factory reset aborted: Invalid PIN', 'error');
            return;
        }

        if (confirm('WARNING: THIS WILL WIPE ALL DATA, SALES BILLS, PRODUCTS, AND AUDIT LOGS. Are you absolutely sure?')) {
            // Delete and rebuild DB
            dbInstance.close();
            const delReq = indexedDB.deleteDatabase(DB_NAME);
            
            delReq.onsuccess = () => {
                showToast('System reset completed. Reloading app...', 'success');
                setTimeout(() => window.location.reload(), 1500);
            };
            delReq.onerror = () => {
                showToast('Reset failed.', 'error');
            };
        }
    } catch (e) {
        showToast('Error during reset: ' + e.message, 'error');
    }
}

// ==========================================
// EVENT LISTENERS & SETUP
// ==========================================
function setupEventListeners() {
    // Bottom Nav clicks
    document.getElementById('nav-home').addEventListener('click', () => switchSection('home'));
    document.getElementById('nav-bill').addEventListener('click', () => switchSection('bill'));
    document.getElementById('nav-admin').addEventListener('click', () => switchSection('admin'));

    // Billing Search
    const searchInput = document.getElementById('billing-search');
    searchInput.addEventListener('input', (e) => handleSearchInput(e.target.value));
    searchInput.addEventListener('focus', (e) => handleSearchInput(e.target.value));

    // Hide search suggestions on document click
    document.addEventListener('click', (e) => {
        const suggest = document.getElementById('search-suggestions');
        if (e.target !== searchInput && !suggest.contains(e.target)) {
            suggest.style.display = 'none';
        }
    });

    // Discount changes
    document.getElementById('billing-discount-type').addEventListener('change', (e) => {
        state.discountType = e.target.value;
        const discountValField = document.getElementById('billing-discount-value');
        state.discountValue = parseFloat(discountValField.value) || 0;
        renderCart();
    });

    document.getElementById('billing-discount-value').addEventListener('input', (e) => {
        state.discountValue = parseFloat(e.target.value) || 0;
        renderCart();
    });

    // GST changes
    document.getElementById('billing-gst-percent').addEventListener('input', (e) => {
        state.gstPercent = parseFloat(e.target.value) || 0;
        renderCart();
    });

    // Scanner triggers
    document.getElementById('btn-scan-product').addEventListener('click', openScannerOverlay);
    document.getElementById('btn-close-scanner').addEventListener('click', closeScannerOverlay);

    // Admin password login form submission
    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('admin-password-input');
        const password = input.value.trim();
        if (!password) return;

        try {
            const hashedPin = await sha256(password);
            const storedHash = await getSetting('admin_pin_hash', DEFAULT_PIN_HASH);

            if (hashedPin === storedHash) {
                state.adminUnlocked = true;
                showToast('Admin session unlocked', 'success');
                input.value = '';
                renderAdminView();
            } else {
                showToast('Invalid administrative password', 'error');
                input.value = '';
                input.focus();
            }
        } catch (err) {
            showToast('Authentication error: ' + err.message, 'error');
        }
    });

    // Checkout
    document.getElementById('btn-checkout').addEventListener('click', handleCheckout);

    // Receipt Close
    document.getElementById('btn-close-receipt').addEventListener('click', closeReceiptModal);
    document.getElementById('btn-print-receipt').addEventListener('click', printActiveReceipt);

    // Admin tab triggers
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            switchAdminTab(e.target.dataset.tab);
        });
    });

    // Admin Unlock logout
    document.getElementById('btn-lock-admin').addEventListener('click', lockAdmin);

    // Analytics Range changes
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            loadAnalytics(e.target.dataset.range);
        });
    });

    document.getElementById('analytics-start-date').addEventListener('change', () => loadAnalytics('custom'));
    document.getElementById('analytics-end-date').addEventListener('change', () => loadAnalytics('custom'));

    // Inventory Search
    document.getElementById('inventory-search').addEventListener('input', renderInventoryList);
    document.getElementById('btn-add-product').addEventListener('click', openProductAddModal);
    document.getElementById('product-form').addEventListener('submit', handleSaveProduct);
    document.getElementById('btn-close-prod-modal').addEventListener('click', closeProductModal);

    // Bills History Search
    document.getElementById('bills-search').addEventListener('input', renderBillsList);
    document.getElementById('btn-close-delbill-modal').addEventListener('click', closeDeleteBillModal);
    document.getElementById('btn-confirm-delete-bill').addEventListener('click', confirmDeleteBill);

    // Settings listeners
    document.getElementById('btn-export-backup').addEventListener('click', handleExportBackup);
    document.getElementById('backup-import-file').addEventListener('change', handleImportBackup);
    document.getElementById('pin-change-form').addEventListener('submit', handleUpdatePin);
    document.getElementById('btn-factory-reset').addEventListener('click', handleFactoryReset);

    // Network status monitoring
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    updateNetworkStatus();
}

function focusSearch() {
    setTimeout(() => {
        const s = document.getElementById('billing-search');
        if (s) s.focus();
    }, 100);
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
    
    // Animate in
    setTimeout(() => toast.classList.add('visible'), 10);

    // Auto destroy
    setTimeout(() => {
        toast.classList.remove('visible');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3500);
}

// Tiny audio synthesis for scanning beep (works perfectly offline!)
function playBeepSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime); // 1000Hz frequency
        
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15); // fade out
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
        // Fallback for security/silence policies
    }
}
