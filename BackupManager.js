// KID'S TRENDS POS - BACKUP MANAGER (BACKUP IMPORT/EXPORT COORDINATOR)

const BackupManager = {
    /**
     * Coordinates data backup. Fetches raw data from db.js, formats it into a single
     * JSON object, and sends it to Android or starts a browser file download.
     */
    async exportBackup() {
        try {
            // Read raw store arrays from db.js (Separation of Concerns: no direct IndexedDB calls)
            const rawData = await exportRawStoresData();
            
            // Extract settings for Cashiers and Admin PIN
            const settingsList = rawData.settings || [];
            
            const adminPinHashObj = settingsList.find(s => s.key === 'admin_pin_hash');
            const adminPasswordHash = adminPinHashObj ? adminPinHashObj.value : DEFAULT_PIN_HASH;

            const cashiersObj = settingsList.find(s => s.key === 'cashiers');
            const cashiersList = cashiersObj ? cashiersObj.value : ['Irfan', 'Faizan', 'Farhan'];

            // Construct unified backup object with exact keys
            const backupObj = {
                Products: rawData.products || [],
                Bills: rawData.bills || [],
                DeletedBills: rawData.deleted_bills || [],
                Settings: rawData.settings || [],
                Cashiers: cashiersList,
                "Admin Password": adminPasswordHash,
                Logs: rawData.audit_logs || [],
                Inventory: rawData.products || [] // Inventory duplicate/alias for device compatibility
            };

            const jsonString = JSON.stringify(backupObj, null, 2);

            if (NativeBridge.exportBackup(jsonString)) {
                NativeBridge.showToast("Backup exported to Android system", "success");
                await logActivity('Backup Exported', 'JSON database backup shared with Android');
            } else {
                // Browser fallback: standard JSON file download
                const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const link = document.createElement('a');
                link.href = url;
                link.download = `kids_trends_backup_${dateStr}.json`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                
                NativeBridge.showToast("Backup downloaded successfully", "success");
                await logActivity('Backup Exported', 'JSON database backup downloaded in browser');
            }
        } catch (e) {
            NativeBridge.showToast('Backup export failed: ' + e.message, 'error');
        }
    },

    /**
     * Initiates backup import. Calls Android bridge or triggers the hidden browser input.
     */
    importBackup() {
        if (NativeBridge.importBackup()) {
            // Android side will trigger window.onImportBackup(backupJsonString)
            return;
        }
        
        // Browser file dialog fallback
        const fileInput = document.getElementById('backup-import-file');
        if (fileInput) {
            fileInput.click();
        }
    },

    /**
     * Validates the schema of imported JSON data.
     * @param {Object} backupData Parsed JSON object.
     * @returns {boolean} True if validation passes.
     */
    validateBackup(backupData) {
        if (!backupData || typeof backupData !== 'object') {
            throw new Error('Backup data is not a valid JSON object.');
        }

        // Must have at least Products/Inventory and Bills
        const hasProducts = Array.isArray(backupData.Products) || Array.isArray(backupData.Inventory) || Array.isArray(backupData.products);
        if (!hasProducts) {
            throw new Error('Missing Products or Inventory inventory lists in backup.');
        }

        const hasBills = Array.isArray(backupData.Bills) || Array.isArray(backupData.bills);
        if (!hasBills) {
            throw new Error('Missing Bills or sales transactions in backup.');
        }

        return true;
    },

    /**
     * Restores database content from JSON backup string.
     * Parses the string, normalizes fields, and writes to IndexedDB using db.js methods.
     * @param {string} jsonDataString JSON backup string content.
     */
    async restoreDatabase(jsonDataString) {
        let backupData;
        try {
            backupData = JSON.parse(jsonDataString);
        } catch (e) {
            throw new Error('Invalid JSON format.');
        }

        // Schema validation
        this.validateBackup(backupData);

        // Normalize JSON content to local IndexedDB store schemas
        const products = backupData.Products || backupData.Inventory || backupData.products || [];
        const bills = backupData.Bills || backupData.bills || [];
        const deletedBills = backupData.DeletedBills || backupData.deleted_bills || [];
        const logs = backupData.Logs || backupData.audit_logs || backupData.logs || [];
        let settings = backupData.Settings || backupData.settings || [];

        // Map Admin Password PIN hash
        const adminPassword = backupData["Admin Password"] || backupData.adminPassword;
        if (adminPassword) {
            const pinIndex = settings.findIndex(s => s.key === 'admin_pin_hash');
            if (pinIndex !== -1) {
                settings[pinIndex].value = adminPassword;
            } else {
                settings.push({ key: 'admin_pin_hash', value: adminPassword });
            }
        }

        // Map Cashiers array
        const cashiers = backupData.Cashiers || backupData.cashiers;
        if (cashiers) {
            const cashiersIndex = settings.findIndex(s => s.key === 'cashiers');
            if (cashiersIndex !== -1) {
                settings[cashiersIndex].value = cashiers;
            } else {
                settings.push({ key: 'cashiers', value: cashiers });
            }
        }

        // Assemble normalized stores payload for db.js write transaction
        const rawData = {
            products,
            bills,
            deleted_bills: deletedBills,
            audit_logs: logs,
            settings
        };

        // Write to IndexedDB via db.js transaction wrapper (centralized database concern)
        await restoreRawStoresData(rawData);
    }
};

// Bind to window to expose globally
window.BackupManager = BackupManager;
