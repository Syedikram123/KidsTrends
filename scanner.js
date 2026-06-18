// KID'S TRENDS POS - OFFLINE QR CODE SCANNER USING jsQR

let videoStream = null;
let scanRequest = null;
let isScanning = false;

/**
 * Checks if scanning is supported. Since we are using jsQR, 
 * it is supported on all browsers that support getUserMedia.
 */
function isBarcodeScannerSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Starts the camera QR code scanner.
 * @param {HTMLVideoElement} videoElement The video element to display the stream.
 * @param {Function} onScanCallback Callback invoked when a QR code is detected.
 * @param {Function} onErrorCallback Callback invoked when an error occurs.
 */
async function startScanner(videoElement, onScanCallback, onErrorCallback) {
    if (isScanning) return;

    if (!isBarcodeScannerSupported()) {
        onErrorCallback(new Error('Camera access is not supported by this browser. Please type product codes manually.'));
        return;
    }

    try {
        // Request back-facing camera
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: false
        });

        videoElement.srcObject = videoStream;
        videoElement.setAttribute('playsinline', true); // critical for iOS
        
        await new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play().then(resolve);
            };
        });

        isScanning = true;

        // Create canvas to process frames
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });

        // Frame scanning loop
        function scanFrame() {
            if (!isScanning) return;

            if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
                canvas.width = videoElement.videoWidth;
                canvas.height = videoElement.videoHeight;
                
                // Draw current video frame to canvas
                context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                
                // Extract image pixel data
                const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                
                // Decode QR using jsQR
                const code = jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: 'dontInvert'
                });

                // If QR code detected
                if (code && code.data) {
                    stopScanner(videoElement);
                    onScanCallback(code.data);
                    return;
                }
            }
            
            // Loop next frame
            scanRequest = requestAnimationFrame(scanFrame);
        }

        // Start animation frame loop
        scanRequest = requestAnimationFrame(scanFrame);

    } catch (err) {
        stopScanner(videoElement);
        onErrorCallback(err);
    }
}

/**
 * Stops the camera and clears video streams.
 */
function stopScanner(videoElement) {
    isScanning = false;
    if (scanRequest) {
        cancelAnimationFrame(scanRequest);
        scanRequest = null;
    }
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        videoStream = null;
    }
    if (videoElement) {
        videoElement.pause();
        videoElement.srcObject = null;
    }
}
