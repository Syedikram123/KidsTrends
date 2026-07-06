// KID'S TRENDS POS - NATIVE BRIDGE (ANDROID BRIDGE COMMUNICATION LAYER)

const NativeBridge = {
    /**
     * Checks if the app is running within the Android WebView environment.
     * @returns {boolean} True if window.Android is defined.
     */
    isAndroid() {
        return !!(window.Android);
    },

    /**
     * Retrieves the version of the Android native bridge.
     * @returns {string} Version identifier.
     */
    bridgeVersion() {
        if (this.isAndroid() && typeof window.Android.bridgeVersion === 'function') {
            try {
                return window.Android.bridgeVersion();
            } catch (e) {
                console.error("Failed to call bridgeVersion:", e);
            }
        }
        return "1.0.0"; // Default version if running in browser or unsupported bridge version
    },

    /**
     * Shows a notification message (toast).
     * @param {string} message The text message to show.
     * @param {string} type Notification category ('info', 'success', 'warning', 'error').
     */
    showToast(message, type = 'info') {
        if (this.isAndroid() && typeof window.Android.showToast === 'function') {
            try {
                window.Android.showToast(message, type);
                return;
            } catch (e) {
                console.error("Failed to show native toast:", e);
            }
        }
        // Fallback to browser UI toast
        if (typeof window.showBrowserToast === 'function') {
            window.showBrowserToast(message, type);
        } else {
            console.log(`[Toast Fallback] [${type.toUpperCase()}] ${message}`);
        }
    },

    /**
     * Shares the receipt image directly via Android WhatsApp service.
     * @param {string} base64Image The temporary receipt image data URL.
     * @param {string} phoneNumber The customer's mobile number with country code.
     * @param {string} message A text message accompanying the share.
     * @returns {boolean} True if successfully invoked native action.
     */
    shareReceipt(base64Image, phoneNumber, message) {
        if (this.isAndroid() && typeof window.Android.shareReceipt === 'function') {
            try {
                window.Android.shareReceipt(base64Image, phoneNumber, message);
                return true;
            } catch (e) {
                console.error("Failed to share receipt via Android bridge:", e);
            }
        }
        return false; // Fallback handled by caller
    },

    /**
     * Prints the receipt image via Android native print service.
     * @param {string} base64Image The temporary receipt image data URL.
     * @returns {boolean} True if successfully invoked native action.
     */
    printReceipt(base64Image) {
        if (this.isAndroid() && typeof window.Android.printReceipt === 'function') {
            try {
                window.Android.printReceipt(base64Image);
                return true;
            } catch (e) {
                console.error("Failed to print receipt via Android bridge:", e);
            }
        }
        return false; // Fallback handled by caller
    },

    /**
     * Launches the Android native scanner interface.
     * @returns {boolean} True if successfully invoked native action.
     */
    scanBarcode() {
        if (this.isAndroid() && typeof window.Android.scanBarcode === 'function') {
            try {
                window.Android.scanBarcode();
                return true;
            } catch (e) {
                console.error("Failed to scan barcode via Android bridge:", e);
            }
        }
        return false; // Fallback handled by caller
    },

    /**
     * Exports the system data backup to the Android file system.
     * @param {string} jsonString Serialized database backup content.
     * @returns {boolean} True if successfully invoked native action.
     */
    exportBackup(jsonString) {
        if (this.isAndroid() && typeof window.Android.exportBackup === 'function') {
            try {
                window.Android.exportBackup(jsonString);
                return true;
            } catch (e) {
                console.error("Failed to export backup via Android bridge:", e);
            }
        }
        return false; // Fallback handled by caller
    },

    /**
     * Triggers the Android system file selector to retrieve a backup JSON.
     * @returns {boolean} True if successfully invoked native action.
     */
    importBackup() {
        if (this.isAndroid() && typeof window.Android.importBackup === 'function') {
            try {
                window.Android.importBackup();
                return true;
            } catch (e) {
                console.error("Failed to import backup via Android bridge:", e);
            }
        }
        return false; // Fallback handled by caller
    }
};

// Bind to window to expose globally
window.NativeBridge = NativeBridge;
