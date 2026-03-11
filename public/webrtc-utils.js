// WebRTC utility functions and configuration
class WebRTCUtils {
    constructor() {
        // Detect if we're offline or on local network
        const isOffline = !navigator.onLine || window.location.hostname === 'localhost';
        
        // STUN/TURN servers for NAT traversal
        this.configuration = {
            iceServers: isOffline ? [
                // Offline/local mode - minimal configuration
                // WebRTC will use host candidates (local IPs)
            ] : [
                // Online mode - full STUN/TURN support
                // Google STUN servers (free and reliable)
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                
                // Public TURN servers (free tier - for production, consider paid services)
                {
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:openrelay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                
                // Additional TURN servers as backup
                {
                    urls: 'turn:turn.relay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:turn.relay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        };
        
        // Quality presets for automatic regulation
        this.qualityPresets = {
            low: { width: 640, height: 480, frameRate: 15, bitrate: 500 },
            medium: { width: 1280, height: 720, frameRate: 25, bitrate: 1500 },
            high: { width: 1920, height: 1080, frameRate: 30, bitrate: 3000 },
            auto: { width: 1280, height: 720, frameRate: 25, bitrate: 1500 }
        };
        
        // Network monitoring
        this.networkStats = {
            bandwidth: 0,
            latency: 0,
            packetLoss: 0
        };
    }

    // Create RTCPeerConnection with configuration
    createPeerConnection() {
        const pc = new RTCPeerConnection(this.configuration);
        
        // Add connection state monitoring for debugging
        pc.onconnectionstatechange = () => {
            console.log('WebRTC Connection State:', pc.connectionState);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.error('WebRTC connection failed/disconnected');
            }
        };
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE Connection State:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'failed') {
                console.error('ICE connection failed - check TURN servers');
            }
        };
        
        pc.onicegatheringstatechange = () => {
            console.log('ICE Gathering State:', pc.iceGatheringState);
        };
        
        return pc;
    }

    // Generate random room ID
    generateRoomId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 6; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Format timestamp for logging
    formatTimestamp() {
        const now = new Date();
        return now.toLocaleTimeString();
    }

    // Add log message to UI
    addLogMessage(containerId, message, type = 'info') {
        const logContainer = document.getElementById(containerId);
        if (!logContainer) {
            // If container doesn't exist, log to console instead
            console.log(`[${this.formatTimestamp()}] ${message}`);
            return;
        }

        const logMessage = document.createElement('div');
        logMessage.className = 'log-message';
        
        const timestamp = document.createElement('span');
        timestamp.className = 'log-time';
        timestamp.textContent = `[${this.formatTimestamp()}] `;
        
        const messageText = document.createElement('span');
        messageText.textContent = message;
        
        // Color coding based on type
        switch(type) {
            case 'error':
                messageText.style.color = '#dc3545';
                break;
            case 'success':
                messageText.style.color = '#28a745';
                break;
            case 'warning':
                messageText.style.color = '#ffc107';
                break;
            default:
                messageText.style.color = '#333';
        }
        
        logMessage.appendChild(timestamp);
        logMessage.appendChild(messageText);
        
        logContainer.appendChild(logMessage);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep only last 50 messages
        while (logContainer.children.length > 50) {
            logContainer.removeChild(logContainer.firstChild);
        }
    }

    // Update connection status indicator
    updateConnectionStatus(statusElementId, status, message) {
        const statusElement = document.getElementById(statusElementId);
        if (!statusElement) return;

        statusElement.className = 'status-indicator';
        
        switch(status) {
            case 'connected':
                statusElement.classList.add('status-connected');
                statusElement.innerHTML = '🟢 ' + message;
                break;
            case 'connecting':
                statusElement.classList.add('status-connecting');
                statusElement.innerHTML = '🟡 ' + message;
                break;
            case 'disconnected':
            default:
                statusElement.classList.add('status-disconnected');
                statusElement.innerHTML = '🔴 ' + message;
                break;
        }
    }

    // Handle ICE candidate events
    setupIceHandlers(peerConnection, socket, targetId) {
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    target: targetId,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE connection state:', peerConnection.iceConnectionState);
            
            switch(peerConnection.iceConnectionState) {
                case 'connected':
                case 'completed':
                    return 'connected';
                case 'connecting':
                    return 'connecting';
                case 'disconnected':
                case 'failed':
                case 'closed':
                    return 'disconnected';
                default:
                    return 'connecting';
            }
        };
    }

    // Create and send offer
    async createOffer(peerConnection, socket, targetId, roomId) {
        try {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: false,
                offerToReceiveVideo: true
            });
            
            await peerConnection.setLocalDescription(offer);
            
            socket.emit('offer', {
                target: targetId,
                roomId: roomId,
                offer: offer
            });
            
            return true;
        } catch (error) {
            console.error('Error creating offer:', error);
            return false;
        }
    }

    // Handle received offer and create answer
    async handleOffer(peerConnection, socket, offer, senderId, roomId) {
        try {
            await peerConnection.setRemoteDescription(offer);
            
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit('answer', {
                target: senderId,
                roomId: roomId,
                answer: answer
            });
            
            return true;
        } catch (error) {
            console.error('Error handling offer:', error);
            return false;
        }
    }

    // Handle received answer
    async handleAnswer(peerConnection, answer) {
        try {
            await peerConnection.setRemoteDescription(answer);
            return true;
        } catch (error) {
            console.error('Error handling answer:', error);
            return false;
        }
    }

    // Handle ICE candidate
    async handleIceCandidate(peerConnection, candidate) {
        try {
            await peerConnection.addIceCandidate(candidate);
            return true;
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
            return false;
        }
    }

    // Get screen capture stream with automatic quality regulation
    async getScreenCapture(targetQuality = 'auto') {
        try {
            // Detect network conditions and adjust quality
            const optimalQuality = this.detectOptimalQuality(targetQuality);
            const qualitySettings = this.qualityPresets[optimalQuality];
            
            console.log(`Using quality: ${optimalQuality}`, qualitySettings);
            
            // Try different methods for getting display media
            let stream;
            
            if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        cursor: 'always',
                        displaySurface: 'monitor',
                        width: { ideal: qualitySettings.width },
                        height: { ideal: qualitySettings.height },
                        frameRate: { ideal: qualitySettings.frameRate }
                    },
                    audio: false
                });
            } else if (navigator.getDisplayMedia) {
                // Fallback for older browsers
                stream = await navigator.getDisplayMedia({
                    video: {
                        cursor: 'always'
                    },
                    audio: false
                });
            } else {
                throw new Error('Screen sharing is not supported in this browser. Please use Chrome, Firefox, or Edge.');
            }
            
            // Apply additional constraints if stream supports them
            if (stream && stream.getVideoTracks().length > 0) {
                const videoTrack = stream.getVideoTracks()[0];
                
                // Apply constraints if supported
                if ('applyConstraints' in videoTrack) {
                    await videoTrack.applyConstraints({
                        width: qualitySettings.width,
                        height: qualitySettings.height,
                        frameRate: qualitySettings.frameRate
                    });
                }
                
                // Store quality info in a separate metadata object (don't modify stream)
                stream._qualityMetadata = {
                    quality: optimalQuality,
                    settings: qualitySettings
                };
                
                // Add getter for quality (read-only)
                Object.defineProperty(stream, 'quality', {
                    get: function() { return this._qualityMetadata.quality; },
                    configurable: false
                });
                
                // Add getter for settings (read-only)
                Object.defineProperty(stream, 'settings', {
                    get: function() { return this._qualityMetadata.settings; },
                    configurable: false
                });
            }
            
            return stream;
        } catch (error) {
            console.error('Error getting screen capture:', error);
            throw error;
        }
    }

    // Detect optimal quality based on network conditions
    detectOptimalQuality(requestedQuality) {
        // If user requests specific quality, use it
        if (requestedQuality !== 'auto') {
            return requestedQuality;
        }
        
        // Auto-detect based on network stats
        const bandwidth = this.networkStats.bandwidth;
        const latency = this.networkStats.latency;
        
        if (bandwidth < 1000) { // Less than 1 Mbps
            return 'low';
        } else if (bandwidth < 2000) { // Less than 2 Mbps
            return latency > 200 ? 'low' : 'medium';
        } else if (bandwidth < 4000) { // Less than 4 Mbps
            return latency > 150 ? 'medium' : 'high';
        } else {
            return 'high';
        }
    }

    // Update network statistics for adaptive quality
    updateNetworkStats(bandwidth, latency, packetLoss = 0) {
        this.networkStats = {
            bandwidth: bandwidth,
            latency: latency,
            packetLoss: packetLoss
        };
        
        console.log('Network stats updated:', this.networkStats);
    }

    // Check browser compatibility
    checkBrowserSupport() {
        // Check for WebRTC support with fallbacks for different browser implementations
        const hasRTCPeerConnection = !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection);
        
        // Check for mediaDevices safely
        let hasMediaDevices = false;
        let hasGetDisplayMedia = false;
        
        try {
            // Try different ways to access mediaDevices
            const mediaDevices = window.mediaDevices || navigator.mediaDevices;
            hasMediaDevices = !!mediaDevices;
            
            if (hasMediaDevices) {
                hasGetDisplayMedia = !!(mediaDevices.getDisplayMedia || navigator.getDisplayMedia);
            }
        } catch (error) {
            console.warn('MediaDevices not available:', error);
            hasMediaDevices = false;
            hasGetDisplayMedia = false;
        }
        
        // More permissive check - allow browsers that have basic WebRTC support
        const isSupported = hasRTCPeerConnection;
        
        if (!isSupported) {
            alert('Your browser does not support WebRTC. Please use a modern browser like Chrome, Firefox, Edge, or Safari 14+.');
            return false;
        }
        
        // Check screen sharing specifically
        if (!hasGetDisplayMedia) {
            console.warn('Screen sharing may not be supported in this browser. You may need to use Chrome, Firefox, or Edge for full functionality.');
            // Don't block the app, just warn the user
        }
        
        return true;
    }

    // Optimize video quality based on connection
    optimizeVideoQuality(peerConnection, quality = 'auto') {
        const sender = peerConnection.getSenders().find(s => 
            s.track && s.track.kind === 'video'
        );
        
        if (!sender) return;
        
        let parameters;
        switch(quality) {
            case 'low':
                parameters = {
                    width: { min: 320, ideal: 640, max: 800 },
                    height: { min: 240, ideal: 480, max: 600 },
                    frameRate: { min: 15, ideal: 20, max: 25 }
                };
                break;
            case 'medium':
                parameters = {
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    frameRate: { min: 20, ideal: 25, max: 30 }
                };
                break;
            case 'high':
                parameters = {
                    width: { min: 1280, ideal: 1920, max: 2560 },
                    height: { min: 720, ideal: 1080, max: 1440 },
                    frameRate: { min: 25, ideal: 30, max: 60 }
                };
                break;
            default: // auto
                parameters = {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 25 }
                };
        }
        
        sender.setParameters({ encodings: [parameters] }).catch(e => {
            console.warn('Failed to set video parameters:', e);
        });
    }
}

// Global instance
const webrtcUtils = new WebRTCUtils();
