// WebRTC utility functions and configuration
class WebRTCUtils {
    constructor() {
        // Prefer local ICE on campus LAN so the app still works well without internet.
        const hostname = window.location.hostname;
        const isPrivateIpv4 = /^(10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/.test(hostname);
        const isOffline = !navigator.onLine || hostname === 'localhost' || hostname.endsWith('.local') || isPrivateIpv4;
        
        // Optimized STUN/TURN servers for faster connection
        this.configuration = {
            iceServers: isOffline ? [] : [
                // Online mode - multiple STUN servers for faster ICE gathering
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                
                // Optimized TURN servers for better connectivity
                {
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:openrelay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ],
            iceCandidatePoolSize: 10, // Pre-gather ICE candidates for faster connection
            iceTransportPolicy: 'all', // Use all available transports
            bundlePolicy: 'max-bundle', // Bundle all streams for efficiency
            rtcpMuxPolicy: 'require' // Require RTCP multiplexing
        };
        
        // Optimized quality presets for better performance
        this.qualityPresets = {
            low: { width: 640, height: 480, frameRate: 15, bitrate: 300 },
            medium: { width: 1280, height: 720, frameRate: 20, bitrate: 1000 },
            high: { width: 1920, height: 1080, frameRate: 25, bitrate: 2000 },
            auto: { width: 1280, height: 720, frameRate: 20, bitrate: 1000 }
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
                offerToReceiveAudio: true,
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

    // Monitor connection performance
    async monitorPerformance(peerConnection, callback) {
        if (!peerConnection) return;

        const statsInterval = setInterval(async () => {
            try {
                const stats = await peerConnection.getStats();
                const performanceData = this.parseStats(stats);
                
                // Update network stats
                this.networkStats = {
                    bandwidth: performanceData.bandwidth || 0,
                    latency: performanceData.latency || 0,
                    packetLoss: performanceData.packetLoss || 0
                };
                
                // Call callback with performance data
                if (callback) callback(performanceData);
                
                // Auto-adjust quality based on performance
                this.autoAdjustQuality(peerConnection, performanceData);
                
            } catch (error) {
                console.error('Error getting performance stats:', error);
            }
        }, 5000); // Monitor every 5 seconds

        return () => clearInterval(statsInterval);
    }

    // Parse WebRTC stats into performance data
    parseStats(stats) {
        const performanceData = {
            timestamp: Date.now(),
            bandwidth: 0,
            latency: 0,
            packetLoss: 0,
            fps: 0,
            bitrate: 0,
            connectionTime: 0
        };

        stats.forEach(report => {
            switch(report.type) {
                case 'inbound-rtp':
                    if (report.mediaType === 'video') {
                        performanceData.fps = report.framesPerSecond || 0;
                        performanceData.bitrate = report.bitrate || 0;
                        performanceData.packetsLost = report.packetsLost || 0;
                        performanceData.packetsReceived = report.packetsReceived || 0;
                    }
                    break;
                case 'outbound-rtp':
                    if (report.mediaType === 'video') {
                        performanceData.bitrateOut = report.bitrate || 0;
                    }
                    break;
                case 'candidate-pair':
                    if (report.state === 'succeeded') {
                        performanceData.latency = report.roundTripTime || 0;
                        performanceData.connectionTime = report.totalRoundTripTime || 0;
                    }
                    break;
                case 'transport':
                    performanceData.bytesReceived = report.bytesReceived || 0;
                    performanceData.bytesSent = report.bytesSent || 0;
                    break;
            }
        });

        // Calculate packet loss percentage
        if (performanceData.packetsLost && performanceData.packetsReceived) {
            const total = performanceData.packetsLost + performanceData.packetsReceived;
            performanceData.packetLoss = (performanceData.packetsLost / total) * 100;
        }

        // Calculate bandwidth (kbps)
        if (performanceData.bytesReceived) {
            performanceData.bandwidth = (performanceData.bytesReceived * 8) / 1024;
        }

        return performanceData;
    }

    // Auto-adjust quality based on performance metrics
    autoAdjustQuality(peerConnection, performanceData) {
        const { bandwidth, latency, packetLoss } = performanceData;
        
        let quality = 'auto';
        
        // Determine quality based on performance
        if (latency > 200 || packetLoss > 5 || bandwidth < 500) {
            quality = 'low';
        } else if (latency > 100 || packetLoss > 2 || bandwidth < 1000) {
            quality = 'medium';
        } else if (latency < 50 && packetLoss < 1 && bandwidth > 2000) {
            quality = 'high';
        }
        
        // Apply quality adjustment
        this.optimizeVideoQuality(peerConnection, quality);
        
        // Log performance data for analysis
        console.log('Performance Metrics:', {
            quality,
            bandwidth: `${bandwidth.toFixed(2)} kbps`,
            latency: `${latency.toFixed(2)} ms`,
            packetLoss: `${packetLoss.toFixed(2)}%`
        });
    }

    // Get browser and network info for performance logging
    getSystemInfo() {
        return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            language: navigator.language,
            cookieEnabled: navigator.cookieEnabled,
            onLine: navigator.onLine,
            connection: navigator.connection ? {
                effectiveType: navigator.connection.effectiveType,
                downlink: navigator.connection.downlink,
                rtt: navigator.connection.rtt,
                saveData: navigator.connection.saveData
            } : null,
            memory: performance.memory ? {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
            } : null,
            timing: performance.timing ? {
                navigationStart: performance.timing.navigationStart,
                loadEventEnd: performance.timing.loadEventEnd,
                domContentLoaded: performance.timing.domContentLoadedEventEnd
            } : null
        };
    }
}

// Global instance
const webrtcUtils = new WebRTCUtils();
