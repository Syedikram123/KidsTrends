// KID'S TRENDS POS - RECEIPT MANAGER (RECEIPT GENERATION & DISPLAY MODULE)

const ReceiptManager = {
    /**
     * Generates a high-quality thermal receipt canvas dynamically from structured bill data.
     * Scale factor of 3x ensures sharp text rendering for printing.
     * @param {Object} bill Structured bill JSON record.
     * @returns {HTMLCanvasElement} The generated canvas.
     */
    generateReceiptCanvas(bill) {
        const items = bill.items || [];
        const scale = 3; // 3x scaling for high-resolution thermal outputs
        const logicalWidth = 280;
        
        // 1. Calculate dynamic height based on structural sections
        let tempY = 30;
        tempY += 20; // Title: KID'S TRENDS
        tempY += 16; // Subtitle: A Complete Kids Wear Collection
        tempY += 16; // Line 1: Near Siddiq Shah Taleem
        tempY += 16; // Line 2: Choubara Road, Bidar
        tempY += 16; // Line 3: GSTIN
        tempY += 16; // Line 4: Phone Numbers
        tempY += 12; // Divider
        tempY += 18; // Metadata: Bill Number
        tempY += 16; // Metadata: Date
        tempY += 16; // Metadata: Time
        tempY += 16; // Metadata: Cashier Name
        if (bill.customerMobile) {
            tempY += 16; // Metadata: Customer Mobile Number
        }
        if (bill.notes) {
            tempY += 16; // Metadata: Notes
        }
        tempY += 12; // Divider
        tempY += 18; // Header: ITEM, QTY, RATE, TOTAL
        tempY += 10; // Divider
        
        items.forEach(() => {
            tempY += 20; // Height per line item
        });
        
        tempY += 12; // Divider
        tempY += 18; // Total: Subtotal
        if (bill.discountAmount > 0) {
            tempY += 18; // Total: Discount
        }
        tempY += 8;  // Divider
        tempY += 20; // Total: Grand Total
        tempY += 14; // Text: Inclusive of all Taxes
        tempY += 8;  // Divider
        tempY += 18; // Total: Amount Paid Mode
        tempY += 8;  // Divider
        tempY += 20; // Footer: 8-Day Replacement Policy
        tempY += 20; // Footer: Thank you visit again
        tempY += 20; // Footer: Software disclaimer
        tempY += 14; // Footer: Contact number
        tempY += 25; // Final bottom padding to avoid cropping
        
        const logicalHeight = tempY;
        
        // 2. Instantiate and setup canvas
        const canvas = document.createElement('canvas');
        canvas.width = logicalWidth * scale;
        canvas.height = logicalHeight * scale;
        
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        
        // White Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, logicalWidth, logicalHeight);
        
        // Header Text
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
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Bill Metadata
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
        if (bill.notes) {
            y += 16;
            ctx.fillText(`Notes: ${bill.notes}`, 15, y);
        }
        
        y += 12;
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Table Header
        y += 18;
        ctx.font = 'bold 12px monospace';
        ctx.fillText("ITEM", 15, y);
        ctx.textAlign = 'center';
        ctx.fillText("QTY", 150, y);
        ctx.textAlign = 'right';
        ctx.fillText("RATE", 215, y);
        ctx.fillText("TOTAL", 270, y);
        
        y += 10;
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Product Rows
        ctx.font = '12px monospace';
        items.forEach(item => {
            y += 20;
            ctx.textAlign = 'left';
            let itemName = `${item.name}-${item.size}`;
            if (itemName.length > 14) {
                itemName = itemName.substring(0, 18) + '..';
            }
            ctx.fillText(itemName, 15, y);
            
            ctx.textAlign = 'center';
            ctx.fillText(String(item.qty), 150, y);
            
            ctx.textAlign = 'right';
            ctx.fillText(`₹${Math.round(item.price)}`, 215, y);
            ctx.fillText(`₹${Math.round(item.total)}`, 270, y);
        });
        
        y += 12;
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Totals
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
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
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
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Payment Info
        y += 18;
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        ctx.fillText("Amount Paid:", 15, y);
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(bill.paymentMode, 270, y);
        
        y += 8;
        this.drawCanvasDivider(ctx, 10, logicalWidth - 10, y);
        
        // Footer Policy & Greeting
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
    },

    /**
     * Utility to draw dashed divider lines on the receipt canvas.
     */
    drawCanvasDivider(ctx, x1, x2, y) {
        ctx.beginPath();
        ctx.setLineDash([2, 2]);
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
    },

    /**
     * Scopes the creation of a temporary Base64 receipt data URL,
     * executes a callback process, and forcefully destroys canvas resources.
     * @param {Object} bill Structured bill JSON record.
     * @param {Function} callback Callback receiving the base64 image string.
     */
    withTemporaryReceiptImage(bill, callback) {
        const canvas = this.generateReceiptCanvas(bill);
        const base64Image = canvas.toDataURL('image/png');
        try {
            callback(base64Image);
        } finally {
            // Force garbage collection on temporary canvas
            canvas.width = 0;
            canvas.height = 0;
        }
    },

    /**
     * Generates a temporary receipt, populates the DOM preview, and displays the modal.
     * @param {Object} bill Structured bill JSON record.
     */
    showReceiptPreview(bill) {
        state.activeBill = bill;
        state.activeBillSource = state.currentSection;
        
        this.withTemporaryReceiptImage(bill, (dataUrl) => {
            const receiptImageHtml = `<img id="preview-receipt-img" src="${dataUrl}" alt="Receipt" style="width: 100%; height: auto; display: block; margin: 0 auto;" />`;
            
            document.getElementById('receipt-modal-body').innerHTML = receiptImageHtml;
            document.getElementById('receipt-print-area').innerHTML = receiptImageHtml;
            document.getElementById('receipt-modal').style.display = 'flex';
        });
    },

    /**
     * Closes the modal and completely wipes all receipt image nodes and DOM structures
     * to release memory.
     */
    destroyReceiptPreview() {
        const imgNode = document.getElementById('preview-receipt-img');
        if (imgNode) {
            imgNode.src = ''; // Break references
        }
        
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
    },

    /**
     * Triggers printing. Calls Android native print bridge or browser window.print() fallback.
     */
    printActiveReceipt() {
        const bill = state.activeBill;
        if (!bill) return;

        this.withTemporaryReceiptImage(bill, (base64Image) => {
            if (NativeBridge.printReceipt(base64Image)) {
                NativeBridge.showToast("Print request sent to Android", "success");
            } else {
                // Fallback to browser window printing
                window.print();
            }
        });
    },

    /**
     * Shares the receipt. If Android is present, generates image and calls Android share.
     * If not, opens standard wa.me URL and copies image to clipboard.
     */
    async handleWhatsAppShare() {
        const bill = state.activeBill;
        if (!bill) {
            NativeBridge.showToast("No active bill to share", "error");
            return;
        }

        let mobileNumber = bill.customerMobile;
        if (!mobileNumber) {
            NativeBridge.showToast("Mobile number is required to share via WhatsApp.", "warning");
            const userMobile = prompt("Please enter customer's 10-digit mobile number:");
            if (userMobile) {
                const cleanMobile = userMobile.replace(/\D/g, '');
                if (cleanMobile.length === 10) {
                    mobileNumber = cleanMobile;
                    bill.customerMobile = mobileNumber;
                    try {
                        await updateBillMobile(bill.id, mobileNumber);
                        this.showReceiptPreview(bill);
                        NativeBridge.showToast("Mobile number updated successfully!", "success");
                    } catch (dbErr) {
                        console.error("Failed to save mobile number:", dbErr);
                    }
                } else {
                    NativeBridge.showToast("Invalid number! Must be exactly 10 digits.", "error");
                    return;
                }
            } else {
                return;
            }
        }

        let cleanMobile = mobileNumber.replace(/\D/g, '');
        if (cleanMobile.length === 10) {
            cleanMobile = '91' + cleanMobile; // Prefix Indian country code
        }

        const message = `Here is your bill from Kid's Trends (Bill No: ${bill.id})`;

        this.withTemporaryReceiptImage(bill, async (base64Image) => {
            if (NativeBridge.shareReceipt(base64Image, cleanMobile, message)) {
                NativeBridge.showToast("Sharing receipt via WhatsApp on Android", "success");
            } else {
                // Browser Fallback Flow: Open wa.me URL and copy receipt to clipboard
                const whatsappUrl = `https://wa.me/${cleanMobile}?text=${encodeURIComponent(message)}`;
                window.open(whatsappUrl, '_blank');

                try {
                    const canvas = this.generateReceiptCanvas(bill);
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
        });
    }
};

// Bind to window to expose globally
window.ReceiptManager = ReceiptManager;
