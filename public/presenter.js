// Professional Presenter Logic

function normalizePresenterEmail(value = '') {
    return String(value || '').trim().toLowerCase();
}

function isValidPresenterEmail(value = '') {
    const email = normalizePresenterEmail(value);
    if (!email || email.length > 254 || email.endsWith('.')) return false;

    const parts = email.split('@');
    if (parts.length !== 2) return false;

    const [localPart, domain] = parts;
    if (!localPart || !domain) return false;
    if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;
    if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)) return false;
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return false;

    return true;
}

function isValidPresenterName(value = '') {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return /^[A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*)+$/.test(normalized);
}

function isValidPresenterTopic(value = '') {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized.length >= 3 && normalized.length <= 120 && /[A-Za-z0-9]/.test(normalized);
}

function isValidDepartmentName(value = '') {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized.length >= 2 && normalized.length <= 100 && /^[A-Za-z][A-Za-z&()\/,.\- ]*[A-Za-z)]$/.test(normalized);
}

function isValidPhysicalRoom(value = '') {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return normalized.length >= 2 && normalized.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9/().#,\- ]*[A-Za-z0-9)]$/.test(normalized);
}

class Presenter {
    constructor() {
        this.socket = null;
        this.roomId = null;
        this.screenStream = null;
        this.micStream = null;
        this.remoteAudioStream = new MediaStream();
        this.incomingStreams = new Map();
        this.peerConnections = new Map();
        this.audienceSize = 1;
        this.activeQualityProfile = null;
        this.isSharing = false;
        this.chatMessages = [];
        this.unreadCount = 0;
        this.performanceMonitors = new Map(); // Track performance monitors
        this.connectionStartTime = null;
    }

    async initializeSocket() {
        const clientConfig = await app.getClientConfig();
        const serverUrl = clientConfig.socketServerUrl;
        
        this.socket = io(serverUrl);
        
        this.socket.on('room-created', (data) => {
            this.roomId = data.roomId;
            app.updateSessionUI(this.roomId, 'Active');
            webrtcUtils.addLogMessage('logMessages', `Lecture Room Active: ${this.roomId}`, 'success');
            
            // Show presenter tools for the active room
            document.getElementById('qrButtonContainer').style.display = 'block';
            document.getElementById('attendanceExportContainer').style.display = 'block';
        });

        this.socket.on('room-error', (message) => {
            if (message) {
                alert(message);
            }
        });

        this.socket.on('student-projection-disabled', (data) => {
            if (data?.message) {
                webrtcUtils.addLogMessage('logMessages', data.message, 'warning');
            }
        });

        this.socket.on('chat-message', (data) => {
            // Use the floating chat system
            if (typeof displayChatMessage === 'function') {
                const userName = document.getElementById('presName')?.value || 'Presenter';
                if (data.sender !== userName) {
                    // Ensure timestamp is present
                    const timestamp = data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    displayChatMessage({
                        text: data.text,
                        sender: data.sender,
                        timestamp: timestamp,
                        isOwn: false
                    });
                    addChatNotificationBadge();
                }
            }
        });

        this.socket.on('screen-share-denied', (data) => {
            const activeName = data?.activeSharerName || 'another participant';
            if (this.screenStream) {
                this.stopScreenShare();
            }
            alert(`Only one screen can be shared at a time. ${activeName} is already presenting.`);
        });
        
        // Initialize chat listeners
        if (typeof initializeChatListeners === 'function') {
            initializeChatListeners(this.socket);
        }

        this.socket.on('student-joined', (studentId) => {
            webrtcUtils.addLogMessage('logMessages', 'Student joined class', 'info');
            if (this.isSharing || this.micStream) {
                this.connectToStudent(studentId);
            }
        });

        this.socket.on('participants-updated', (list) => this.updateParticipantsUI(list));
        this.socket.on('class-scale-update', (data) => {
            if (typeof updateScaleModeBanner === 'function') {
                updateScaleModeBanner(data);
            }
        });

        this.socket.on('student-projection-requested', (data) => {
            if (!this.peerConnections.has(data.studentId)) {
                this.connectToStudent(data.studentId);
            }
        });

        this.socket.on('student-screen-share-started', (data) => {
            console.log('Student started screen sharing:', data);
            webrtcUtils.addLogMessage('logMessages', `Student started sharing screen`, 'info');
        });

        this.socket.on('screen-stopped', (data) => {
            const video = document.getElementById('mainVideo');
            if (this.isSharing && this.screenStream) {
                this.showLocalPreview(this.screenStream);
                video.style.display = 'block';
                document.getElementById('waitingMessage').style.display = 'none';
            } else {
                video.srcObject = null;
                video.muted = false;
                document.getElementById('waitingMessage').style.display = 'flex';
            }
        });

        this.socket.on('answer', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        });

        this.socket.on('ice-candidate', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        });

        this.socket.on('offer', async (data) => {
            let pc = this.peerConnections.get(data.sender);
            if (!pc) {
                pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
                this.peerConnections.set(data.sender, pc);
                
                pc.onicecandidate = (e) => {
                    if (e.candidate) this.socket.emit('ice-candidate', { target: data.sender, candidate: e.candidate });
                };

                pc.ontrack = (e) => {
                    console.log("Student media received");
                    this.handleIncomingTrack(data.sender, e);
                };
            }

            if (data.offer) {
                // Add local tracks if we are sharing
                if (this.screenStream) {
                    this.screenStream.getTracks().forEach(t => {
                        if (!pc.getSenders().find(s => s.track === t)) {
                            pc.addTrack(t, this.screenStream);
                        }
                    });
                }
                if (this.micStream) {
                    this.micStream.getTracks().forEach(t => {
                        if (!pc.getSenders().find(s => s.track === t)) {
                            pc.addTrack(t, this.micStream);
                        }
                    });
                }

                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.socket.emit('answer', { target: data.sender, roomId: this.roomId, answer });
            }
        });
    }

    async createRoom() {
        const details = {
            name: document.getElementById('presName').value.trim().replace(/\s+/g, ' '),
            email: normalizePresenterEmail(document.getElementById('presEmail').value),
            topic: document.getElementById('presTopic').value.trim().replace(/\s+/g, ' '),
            department: document.getElementById('presDept').value.trim().replace(/\s+/g, ' '),
            room: document.getElementById('presRoom').value.trim().replace(/\s+/g, ' ')
        };

        if (!details.name) return alert('Presenter name is required.');
        if (!isValidPresenterName(details.name)) return alert('Enter the presenter full name using letters only.');
        if (!details.email) return alert('Presenter email is required.');
        if (!isValidPresenterEmail(details.email)) return alert('Enter a valid presenter email.');
        if (!details.topic) return alert('Lecture topic is required.');
        if (!isValidPresenterTopic(details.topic)) return alert('Enter a valid lecture topic.');
        if (!details.department) return alert('Department is required.');
        if (!isValidDepartmentName(details.department)) return alert('Enter a valid department name.');
        if (!details.room) return alert('Physical room or lab is required.');
        if (!isValidPhysicalRoom(details.room)) return alert('Enter a valid physical room or lab.');

        let generatedId = null;
        try {
            const response = await fetch('/api/room-id', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ presenterDetails: details })
            });
            if (response.ok) {
                const payload = await response.json();
                generatedId = payload.roomId;
            }
        } catch (error) {
            console.warn('Unable to fetch secure room id preview, server will generate one on create');
        }

        this.socket.emit('create-room', { roomId: generatedId, presenterDetails: details });
    }

    generateQRCode() {
        const currentUrl = window.location.origin + window.location.pathname;
        const joinUrl = `${currentUrl}?room=${this.roomId}`;
        
        // Set room ID in modal
        document.getElementById('qrModalRoomId').textContent = this.roomId;
        
        // Clear previous QR code
        document.getElementById('qrModalCode').innerHTML = '';
        
        // Generate QR code using qrcodejs
        new QRCode(document.getElementById('qrModalCode'), {
            text: joinUrl,
            width: 280,
            height: 280,
            colorDark: '#333399',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    sendChatMessage(message) {
        if (!message.trim() || !this.roomId) {
            console.log('Presenter sendChatMessage blocked:', { message: message.trim(), roomId: this.roomId });
            return;
        }
        
        const chatData = {
            roomId: this.roomId,
            senderName: 'Host',
            message: message.trim(),
            role: 'presenter',
            timestamp: new Date().toISOString()
        };
        
        console.log('Presenter sending chat data:', chatData);
        this.socket.emit('chat-message', chatData);
        // Don't add to own messages - server will broadcast back
    }

    addChatMessage(data) {
        this.chatMessages.push(data);
        this.renderChatMessage(data);
        this.scrollToChatBottom();
    }

    renderChatMessage(data) {
        // Add to both chat containers
        const containers = ['chatMessages', 'chatMessagesRegular'];
        
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (!messagesContainer) return;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = `chat-message ${data.role}`;
            
            const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            messageDiv.innerHTML = `
                <div class="chat-message-header">
                    <span class="chat-message-name">${data.senderName}</span>
                    <span class="chat-message-time">${time}</span>
                </div>
                <div class="chat-message-text">${data.message}</div>
            `;
            
            messagesContainer.appendChild(messageDiv);
        });
    }

    scrollToChatBottom() {
        const containers = ['chatMessages', 'chatMessagesRegular'];
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        });
    }

    clearChat() {
        this.chatMessages = [];
        const containers = ['chatMessages', 'chatMessagesRegular'];
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (messagesContainer) {
                messagesContainer.innerHTML = '';
            }
        });
    }

    endSession() {
        this.clearChat();
        // Other cleanup logic...
    }

    async toggleMic(enabled) {
        if (enabled) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const track = this.micStream.getAudioTracks()[0];
                if (this.peerConnections.size === 0 && this.roomId) {
                    this.socket.emit('request-student-projection', { roomId: this.roomId });
                }
                this.peerConnections.forEach(pc => {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                    if (sender) sender.replaceTrack(track);
                    else pc.addTrack(track, this.micStream);
                });
                await this.renegotiateAllPeers();
            } catch (e) { console.error("Mic Error", e); }
        } else if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
            this.peerConnections.forEach(pc => {
                const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
                if (audioSender) {
                    audioSender.replaceTrack(null).catch(() => {});
                }
            });
            await this.renegotiateAllPeers();
        }
    }

    async startScreenShare() {
        try {
            const allowSystemAudio = typeof app?.isSystemAudioAllowed === 'function'
                ? app.isSystemAudioAllowed()
                : true;
            const requestedProfile = this.getShareQualityProfile();
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: {
                    width: { ideal: requestedProfile.width },
                    height: { ideal: requestedProfile.height },
                    frameRate: { ideal: requestedProfile.frameRate, max: requestedProfile.frameRate }
                }, 
                audio: allowSystemAudio
            });

            const screenVideoTrack = this.screenStream.getVideoTracks()[0];
            if (screenVideoTrack) {
                // Optimize for slides/text legibility over motion smoothness.
                screenVideoTrack.contentHint = 'detail';
            }
            
            const video = document.getElementById('mainVideo');
            this.showLocalPreview(this.screenStream);
            video.style.display = 'block';
            document.getElementById('waitingMessage').style.display = 'none';
            this.isSharing = true;

            await this.applyShareQualityProfile();

            if (!allowSystemAudio) {
                webrtcUtils.addLogMessage(
                    'logMessages',
                    'Presentation mode is active. System/tab audio capture is disabled to keep large classes stable. Use microphone narration instead.',
                    'warning'
                );
            }

            // Get screen/share information for tracking
            const screenTrack = this.screenStream.getVideoTracks()[0];
            const settings = screenTrack.getSettings();
            const trackLabel = screenTrack.label || 'Screen Share';
            
            // Detect content type and extract information
            let contentTitle = trackLabel;
            let contentDescription = `Screen resolution: ${settings.width}x${settings.height}`;
            let slideCount = null;
            
            // Try to detect if it's a presentation
            if (trackLabel.toLowerCase().includes('powerpoint') || 
                trackLabel.toLowerCase().includes('presentation') ||
                trackLabel.toLowerCase().includes('slide')) {
                
                contentDescription = 'Presentation being shared';
                // You could add slide detection logic here
            }
            
            // Send content tracking information to server
            this.socket.emit('screen-share-start', {
                roomId: this.roomId,
                shareType: 'screen', // Let server detect the actual type
                contentTitle: contentTitle,
                contentDescription: contentDescription,
                slideCount: slideCount,
                streamSettings: {
                    width: settings.width,
                    height: settings.height,
                    frameRate: settings.frameRate
                }
            });

            this.screenStream.getVideoTracks()[0].onended = () => {
                this.stopScreenShare();
            };

            // Add tracks to all existing peer connections
            this.peerConnections.forEach(async (pc, peerId) => {
                this.screenStream.getTracks().forEach(track => pc.addTrack(track, this.screenStream));
                if (this.micStream) {
                    this.micStream.getTracks().forEach(track => pc.addTrack(track, this.micStream));
                }
                
                // Renegotiate
                const offer = await pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });
                await pc.setLocalDescription(offer);
                this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
            });

            // Notify everyone in the room
            this.socket.emit('request-student-projection', { roomId: this.roomId });
            
            webrtcUtils.addLogMessage('logMessages', `Started sharing: ${contentTitle}`, 'success');
            
        } catch (e) { 
            console.error("Screen share error:", e);
            webrtcUtils.addLogMessage('logMessages', 'Failed to start screen sharing', 'error');
        }
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        const video = document.getElementById('mainVideo');
        video.srcObject = null;
        video.muted = false;
        document.getElementById('waitingMessage').style.display = 'flex';
        this.isSharing = false;
        
        // Notify all students
        if (this.socket && this.roomId) {
            this.socket.emit('screen-stopped', this.roomId);
            // Send content tracking stop event
            this.socket.emit('screen-share-stop');
        }

        // Update UI state
        app.isSharing = false;
        if (typeof syncActionButtons === 'function') {
            syncActionButtons();
        }
        
        webrtcUtils.addLogMessage('logMessages', 'Screen sharing stopped', 'info');
    }

    async connectToStudent(studentId) {
        if (this.peerConnections.has(studentId)) {
            return;
        }

        const connectionStartTime = Date.now();
        const pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
        this.peerConnections.set(studentId, pc);

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => pc.addTrack(t, this.screenStream));
        }
        
        // Include mic if active
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => pc.addTrack(t, this.micStream));
        }

        this.applySenderParametersForPeer(pc).catch(() => {});

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('ice-candidate', { target: studentId, candidate: e.candidate });
        };

        pc.ontrack = (e) => {
            this.handleIncomingTrack(studentId, e);
        };

        // Add performance monitoring when connection is established
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(studentId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(studentId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(studentId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(studentId);
            }
        };

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                console.warn(`Connection timeout for student ${studentId}`);
                this.logConnectionFailure(studentId, 'timeout');
            }
        }, 15000); // 15 second timeout

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: studentId, roomId: this.roomId, offer });
        
        // Clear timeout when connection is established or fails
        pc.onconnectionstatechange = () => {
            if (pc.connectionState !== 'connecting' && pc.connectionState !== 'new') {
                clearTimeout(connectionTimeout);
            }
            
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(studentId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(studentId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(studentId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(studentId);
            }
        };
    }

    // Log connection performance metrics
    async logConnectionPerformance(studentId, connectionTime) {
        try {
            const systemInfo = webrtcUtils.getSystemInfo();
            const performanceData = {
                connection_time_ms: connectionTime,
                browser_info: systemInfo.userAgent,
                network_type: systemInfo.connection?.effectiveType || 'unknown',
                timestamp: Date.now()
            };

            // Log to database if session exists
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'connection',
                        message: `Student connected in ${connectionTime}ms`,
                        metrics: performanceData
                    })
                });
            }

            console.log(`Connection Performance - Student ${studentId}: ${connectionTime}ms`);
        } catch (error) {
            console.error('Error logging connection performance:', error);
        }
    }

    // Log connection failure
    async logConnectionFailure(studentId, failureReason) {
        try {
            const systemInfo = webrtcUtils.getSystemInfo();
            const performanceData = {
                failure_reason: failureReason,
                browser_info: systemInfo.userAgent,
                network_type: systemInfo.connection?.effectiveType || 'unknown',
                timestamp: Date.now()
            };

            // Log to database if session exists
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'error',
                        message: `Connection failed: ${failureReason}`,
                        metrics: performanceData
                    })
                });
            }

            console.warn(`Connection Failure - Student ${studentId}: ${failureReason}`);
        } catch (error) {
            console.error('Error logging connection failure:', error);
        }
    }

    // Start performance monitoring for a connection
    startPerformanceMonitoring(studentId, peerConnection) {
        if (!this.shouldMonitorPeerPerformance()) {
            return;
        }

        const stopMonitoring = webrtcUtils.monitorPerformance(peerConnection, (performanceData) => {
            // Log performance data periodically
            this.logPerformanceMetrics(studentId, performanceData);
        });

        // Store stop function for cleanup
        this.performanceMonitors.set(studentId, stopMonitoring);
    }

    // Stop performance monitoring for a connection
    stopPerformanceMonitoring(studentId) {
        const stopMonitoring = this.performanceMonitors.get(studentId);
        if (stopMonitoring) {
            stopMonitoring();
            this.performanceMonitors.delete(studentId);
        }
    }

    // Log performance metrics to database
    async logPerformanceMetrics(studentId, performanceData) {
        try {
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'performance',
                        message: `Performance: ${performanceData.bandwidth.toFixed(2)}kbps, ${performanceData.latency.toFixed(2)}ms latency`,
                        metrics: performanceData
                    })
                });
            }
        } catch (error) {
            console.error('Error logging performance metrics:', error);
        }
    }

    getOrCreateIncomingStream(peerId) {
        let stream = this.incomingStreams.get(peerId);
        if (!stream) {
            stream = new MediaStream();
            this.incomingStreams.set(peerId, stream);
        }
        return stream;
    }

    attachRemoteAudioTrack(track) {
        const remoteAudio = document.getElementById('remoteAudio');
        if (!remoteAudio) return;

        if (!this.remoteAudioStream.getAudioTracks().some(existing => existing.id === track.id)) {
            this.remoteAudioStream.addTrack(track);
        }

        remoteAudio.srcObject = this.remoteAudioStream;
        remoteAudio.muted = false;
        remoteAudio.volume = 1;
        remoteAudio.play().catch(() => {});
    }

    showLocalPreview(stream) {
        const video = document.getElementById('mainVideo');
        if (!video) return;

        video.srcObject = stream;
        video.muted = true;
        video.volume = 0;
    }

    showRemoteStream(stream) {
        const video = document.getElementById('mainVideo');
        if (!video) return;

        video.srcObject = stream;
        video.muted = false;
        video.volume = 1;
        video.style.display = 'block';
    }

    handleIncomingTrack(peerId, event) {
        const mergedStream = this.getOrCreateIncomingStream(peerId);
        const track = event.track;

        if (!mergedStream.getTracks().some(existing => existing.id === track.id)) {
            mergedStream.addTrack(track);
        }

        track.onended = () => {
            mergedStream.removeTrack(track);
            if (track.kind === 'audio') {
                this.remoteAudioStream.removeTrack(track);
            }
        };

        if (track.kind === 'audio') {
            this.attachRemoteAudioTrack(track);
        }

        if (track.kind === 'video') {
            this.showRemoteStream(mergedStream);
            document.getElementById('waitingMessage').style.display = 'none';
        }
    }

    async renegotiateAllPeers() {
        if (!this.socket || !this.roomId) return;

        for (const [peerId, pc] of this.peerConnections.entries()) {
            if (pc.signalingState !== 'stable') continue;

            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            await pc.setLocalDescription(offer);
            this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
        }
    }

    updateParticipantsUI(participants) {
        const list = document.getElementById('studentGrid');
        document.getElementById('studentCount').textContent = participants.length;
        this.audienceSize = participants.length + 1;
        list.innerHTML = participants.map(p => `
            <div class="participant-chip">
                <div class="avatar">${p.name.charAt(0).toUpperCase()}</div>
                <div class="p-name">${p.name}</div>
            </div>
        `).join('');

        if (this.screenStream) {
            this.applyShareQualityProfile().catch(() => {});
        }
    }

    getShareQualityProfile() {
        if (this.audienceSize >= 40) {
            return { name: 'xlarge', width: 1024, height: 576, frameRate: 5, bitrateKbps: 500 };
        }
        if (this.audienceSize >= 20) {
            return { name: 'large', width: 1280, height: 720, frameRate: 6, bitrateKbps: 850 };
        }
        if (this.audienceSize >= 10) {
            return { name: 'medium', width: 1600, height: 900, frameRate: 8, bitrateKbps: 1400 };
        }
        return { name: 'small', width: 1920, height: 1080, frameRate: 12, bitrateKbps: 2600 };
    }

    shouldMonitorPeerPerformance() {
        return this.audienceSize <= 8;
    }

    async applyShareQualityProfile() {
        if (!this.screenStream) return;
        const track = this.screenStream.getVideoTracks()[0];
        if (!track) return;

        const profile = this.getShareQualityProfile();
        const profileChanged = this.activeQualityProfile?.name !== profile.name;
        this.activeQualityProfile = profile;

        try {
            await track.applyConstraints({
                width: { ideal: profile.width, max: profile.width },
                height: { ideal: profile.height, max: profile.height },
                frameRate: { ideal: profile.frameRate, max: profile.frameRate }
            });
        } catch (error) {
            // Some browsers reject strict screen-share constraints, continue with sender limits.
        }

        await Promise.all(
            Array.from(this.peerConnections.values()).map((pc) =>
                this.applySenderParametersForPeer(pc)
            )
        );

        if (profileChanged) {
            webrtcUtils.addLogMessage(
                'logMessages',
                `Broadcast optimized for ${this.audienceSize} participants (${profile.width}x${profile.height} @ ${profile.frameRate}fps)`,
                'info'
            );
        }
    }

    async applySenderParametersForPeer(pc) {
        const profile = this.activeQualityProfile || this.getShareQualityProfile();
        const videoSender = pc.getSenders().find((sender) => sender.track && sender.track.kind === 'video');
        if (!videoSender || !videoSender.getParameters) return;

        const params = videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) {
            params.encodings = [{}];
        }

        params.degradationPreference = 'maintain-resolution';
        params.encodings[0].maxBitrate = profile.bitrateKbps * 1000;
        params.encodings[0].maxFramerate = profile.frameRate;

        try {
            await videoSender.setParameters(params);
        } catch (error) {
            // Ignore per-browser sender tuning failures.
        }
    }

    async exportAttendance() {
        if (!this.roomId) {
            alert('No active session found');
            return;
        }

        try {
            const response = await fetch(`/api/session/${this.roomId}/attendance/export`);
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `attendance_${this.roomId}_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                webrtcUtils.addLogMessage('logMessages', 'Attendance exported successfully', 'success');
            } else {
                const error = await response.json();
                alert('Failed to export attendance: ' + error.error);
            }
        } catch (error) {
            console.error('Error exporting attendance:', error);
            alert('Failed to export attendance. Please try again.');
        }
    }

    formatAttendanceDateTime(value) {
        if (!value) return 'N/A';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'N/A';
        return date.toLocaleString();
    }

    formatAttendanceDuration(totalSeconds) {
        const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
        const hours = Math.floor(safeSeconds / 3600);
        const minutes = Math.floor((safeSeconds % 3600) / 60);
        const seconds = safeSeconds % 60;
        const parts = [];

        if (hours) parts.push(`${hours} hr${hours === 1 ? '' : 's'}`);
        if (minutes) parts.push(`${minutes} min`);
        if (seconds || !parts.length) parts.push(`${seconds} sec`);

        return parts.join(' ');
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async showAttendanceSummary() {
        if (!this.roomId) {
            alert('No active session found');
            return;
        }

        const modal = document.getElementById('attendanceSummaryModal');
        const mount = document.getElementById('attendanceSummaryMount');
        const meta = document.getElementById('attendanceSummaryMeta');
        if (!modal || !mount || !meta) return;

        modal.style.display = 'flex';
        mount.innerHTML = '<div class="attendance-summary-empty">Loading attendance...</div>';
        meta.textContent = `Room ${this.roomId}`;

        try {
            const response = await fetch(`/api/session/${this.roomId}/attendance/summary`);
            const rows = await response.json();

            if (!response.ok) {
                throw new Error(rows.error || 'Failed to fetch attendance summary');
            }

            meta.textContent = `Room ${this.roomId} • ${rows.length} student${rows.length === 1 ? '' : 's'}`;

            if (!rows.length) {
                mount.innerHTML = '<div class="attendance-summary-empty">No attendance records yet.</div>';
                return;
            }

            mount.innerHTML = `
                <div class="attendance-summary-wrap">
                    <table class="attendance-summary-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Email</th>
                                <th>Joins</th>
                                <th>First Joined</th>
                                <th>Last Seen</th>
                                <th>Status</th>
                                <th>Total Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((row) => {
                                const status = String(row.attendance_status || 'Disconnected');
                                const statusClass = status.toLowerCase() === 'in session' ? 'good' : 'warn';
                                return `
                                    <tr>
                                        <td>${this.escapeHtml(row.name || 'Unknown')}</td>
                                        <td>${this.escapeHtml(row.email || 'N/A')}</td>
                                        <td>${Number(row.join_count) || 0}</td>
                                        <td>${this.escapeHtml(this.formatAttendanceDateTime(row.first_joined_at))}</td>
                                        <td>${this.escapeHtml(this.formatAttendanceDateTime(row.last_seen_at))}</td>
                                        <td><span class="${statusClass}">${status}</span></td>
                                        <td>${this.escapeHtml(this.formatAttendanceDuration(row.total_duration_seconds))}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        } catch (error) {
            console.error('Error loading attendance summary:', error);
            mount.innerHTML = `<div class="attendance-summary-empty">Failed to load attendance summary. ${error.message || ''}</div>`;
        }
    }

    endSession() {
        if (!this.roomId) {
            alert('No active session to end');
            return;
        }

        if (confirm('Are you sure you want to end this session? All students will be disconnected.')) {
            // Disconnect from socket - this will trigger the server to end the session
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // Clear local data
            this.roomId = null;
            this.isSharing = false;
            
            // Stop screen sharing if active
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }
            
            // Stop microphone if active
            if (this.micStream) {
                this.micStream.getTracks().forEach(track => track.stop());
                this.micStream = null;
            }
            
            // Clear peer connections
            this.peerConnections.clear();
            
            // Return to role selection
            location.reload();
        }
    }
}

const presenter = new Presenter();
function createRoom() { presenter.createRoom(); }
function exportAttendance() { presenter.exportAttendance(); }
function openAttendanceSummaryModal() { presenter.showAttendanceSummary(); }
function closeAttendanceSummaryModal() {
    const modal = document.getElementById('attendanceSummaryModal');
    if (modal) modal.style.display = 'none';
}
function endSession() { presenter.endSession(); }
