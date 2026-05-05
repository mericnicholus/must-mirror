// Professional Student Logic

// Configuration
const FOCUS_DETECTION_ENABLED = true; // Set to false to disable focus detection

function normalizeEmailInput(value = '') {
    return String(value || '').trim().toLowerCase();
}

function isValidEmailInput(value = '') {
    const email = normalizeEmailInput(value);
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

function isValidStudentEmailInput(value = '') {
    const email = normalizeEmailInput(value);
    if (!isValidEmailInput(email)) return false;

    const parts = email.split('@');
    if (parts.length !== 2) return false;

    return parts[1] === 'std.must.ac.ug';
}

function isValidFullName(value = '') {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    return /^[A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*)+$/.test(normalized);
}

function isValidRoomCode(value = '') {
    return /^[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,3}$/.test(String(value || '').trim().toUpperCase());
}

class Student {
    constructor() {
        this.storageKey = 'mustMirrorStudentCredentials';
        this.socket = null;
        this.roomId = null;
        this.socketId = null;
        this.peerConnections = new Map(); // Store connections for each sender
        this.screenStream = null;
        this.micStream = null;
        this.remoteAudioStream = new MediaStream();
        this.incomingStreams = new Map();
        this.audienceSize = 1;
        this.activeQualityProfile = null;
        this.presenterId = null;
        this.presenterStream = null;
        this.chatMessages = [];
        this.studentName = '';
        this.isActive = true;
        this.warningTimeout = null;
        this.logoutTimeout = null;
        this.performanceMonitors = new Map(); // Track performance monitors
        this.connectionStartTime = null;
        this.initializeStoredCredentials();
    }

    getStoredCredentials() {
        try {
            const raw = window.localStorage.getItem(this.storageKey);
            return raw ? JSON.parse(raw) : {};
        } catch (error) {
            return {};
        }
    }

    saveCredentials(partialDetails = {}) {
        const current = this.getStoredCredentials();
        const next = {
            name: partialDetails.name ?? document.getElementById('studentName')?.value?.trim() ?? current.name ?? '',
            email: partialDetails.email ?? document.getElementById('studentEmail')?.value?.trim() ?? current.email ?? '',
            roomId: partialDetails.roomId ?? document.getElementById('joinRoomId')?.value?.trim() ?? current.roomId ?? ''
        };

        try {
            window.localStorage.setItem(this.storageKey, JSON.stringify(next));
        } catch (error) {
            console.warn('Unable to save student credentials locally', error);
        }
    }

    restoreCredentials() {
        const details = this.getStoredCredentials();
        const nameField = document.getElementById('studentName');
        const emailField = document.getElementById('studentEmail');
        const roomField = document.getElementById('joinRoomId');

        if (nameField && details.name && !nameField.value.trim()) {
            nameField.value = details.name;
        }

        if (emailField && details.email && !emailField.value.trim()) {
            emailField.value = details.email;
        }

        if (roomField && details.roomId && !roomField.value.trim()) {
            roomField.value = details.roomId;
        }
    }

    initializeStoredCredentials() {
        const bindRestore = () => {
            this.restoreCredentials();
            ['studentName', 'studentEmail', 'joinRoomId'].forEach((fieldId) => {
                const field = document.getElementById(fieldId);
                if (!field || field.dataset.persistBound === 'true') return;

                field.dataset.persistBound = 'true';
                field.addEventListener('input', () => this.saveCredentials());
                field.addEventListener('change', () => this.saveCredentials());
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindRestore, { once: true });
        } else {
            bindRestore();
        }
    }

    async initializeSocket() {
        const clientConfig = await app.getClientConfig();
        const serverUrl = clientConfig.socketServerUrl;
        
        console.log('Student connecting to:', serverUrl);
        console.log('Current hostname:', window.location.hostname);
        
        this.socket = io(serverUrl);

        this.socket.on('connect', () => {
            console.log('Student socket connected:', this.socket.id);
            this.socketId = this.socket.id;
        });

        this.socket.on('disconnect', () => {
            console.log('Student socket disconnected');
        });

        this.socket.on('connect_error', (error) => {
            console.error('Student socket connection error:', error);
        });

        this.socket.on('room-available', (room) => this.updateDiscoveryList(room));

        this.socket.on('room-error', (message) => {
            if (message) {
                alert(message);
            }
        });

        this.socket.on('student-projection-disabled', (data) => {
            if (data?.message) {
                alert(data.message);
            }
        });

        this.socket.on('room-joined', (data) => {
            this.roomId = data.roomId;
            this.studentName = data.studentName;
            this.saveCredentials({
                name: data.studentName,
                roomId: data.roomId
            });
            app.updateSessionUI(this.roomId, 'Joined');
            this.displayPresenterDetails(data.presenterDetails);
            
            // Ensure waiting message is visible when joining room
            document.getElementById('waitingMessage').style.display = 'flex';
            
            // Show focus policy notification and start focus detection
            if (FOCUS_DETECTION_ENABLED) {
                this.showFocusPolicyNotification();
                
                // Start focus detection after joining room
                setTimeout(() => {
                    this.initializeFocusDetection();
                }, 2000); // Start after 2 seconds to allow student to read the policy
            }
        });

        this.socket.on('session-ended', (data) => {
            // Handle session ended by presenter
            this.showSessionEndedNotification(data.message || 'Session has been ended by the presenter');
            setTimeout(() => {
                location.reload();
            }, 3000);
        });

        this.socket.on('chat-message', (data) => {
            // Use the floating chat system
            if (typeof displayChatMessage === 'function') {
                const userName = document.getElementById('studentName')?.value || 'Student';
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
        
        // Initialize chat listeners
        if (typeof initializeChatListeners === 'function') {
            initializeChatListeners(this.socket);
        }

        this.socket.on('room-joined', (data) => {
            webrtcUtils.addLogMessage('logMessages', `Successfully joined room: ${this.roomId}`, 'success');
        });

        this.socket.on('presenter-info', (data) => {
            this.presenterId = data.presenterId;
        });

        this.socket.on('student-projection-requested', (data) => {
            if (!this.peerConnections.has(data.studentId)) {
                this.connectToPeer(data.studentId);
            }
        });

        this.socket.on('student-screen-share-started', (data) => {
            console.log('Student started screen sharing:', data);
        });

        this.socket.on('screen-share-denied', (data) => {
            const activeName = data?.activeSharerName || 'another participant';
            if (this.screenStream) {
                this.stopScreenShare();
            }
            alert(`Only one screen can be shared at a time. ${activeName} is already presenting.`);
        });

        this.socket.on('offer', async (data) => this.handleOffer(data));

        this.socket.on('answer', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        });

        this.socket.on('ice-candidate', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        });

        this.socket.on('participants-updated', (list) => this.updateParticipantsUI(list));
        this.socket.on('class-scale-update', (data) => {
            if (typeof updateScaleModeBanner === 'function') {
                updateScaleModeBanner(data);
            }
        });

        this.socket.on('screen-stopped', (data) => {
            const video = document.getElementById('mainVideo');
            
            // Only hide waiting message if we have a presenter stream
            if (this.presenterStream) {
                this.showRemoteStream(this.presenterStream);
                video.style.display = 'block';
                document.getElementById('waitingMessage').style.display = 'none';
            } else {
                video.srcObject = null;
                video.muted = false;
                // Show waiting message when no presenter stream is available
                document.getElementById('waitingMessage').style.display = 'flex';
                // User requested a "refresh" feel when presenter stops
                if (data && data.senderId === this.presenterId) {
                    webrtcUtils.addLogMessage('logMessages', 'Presenter stopped sharing.', 'info');
                }
            }
        });

        this.socket.on('presenter-disconnected', () => {
            alert('Session ended.');
            location.reload();
        });
    }

    joinRoom() {
        console.log('Student joinRoom called');
        console.log('Socket connected:', this.socket?.connected);
        console.log('Socket ID:', this.socket?.id);
        
        const details = {
            name: document.getElementById('studentName').value.trim().replace(/\s+/g, ' '),
            email: normalizeEmailInput(document.getElementById('studentEmail').value),
            roomId: document.getElementById('joinRoomId').value.trim().toUpperCase()
        };

        console.log('Join details:', details);

        if (!details.name) return alert('Student name is required.');
        if (!isValidFullName(details.name)) return alert('Enter your full name using letters only.');
        if (!details.email) return alert('Student email is required.');
        if (!isValidStudentEmailInput(details.email)) return alert('Enter a valid student email ending with @std.must.ac.ug.');
        if (!details.roomId) return alert('Room ID is required.');
        if (!isValidRoomCode(details.roomId)) return alert('Enter a valid room ID.');

        this.saveCredentials(details);

        if (!this.socket || !this.socket.connected) {
            console.error('Socket not connected - cannot join room');
            alert('Connection error. Please refresh the page and try again.');
            return;
        }

        console.log('Emitting join-room event');
        this.socket.emit('join-room', details);
    }

    async toggleMic(enabled) {
        if (enabled) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                if (this.peerConnections.size === 0 && this.roomId) {
                    this.socket.emit('request-student-projection', { roomId: this.roomId });
                }
                this.peerConnections.forEach(pc => {
                    const track = this.micStream.getAudioTracks()[0];
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
                    'Presentation mode is active. System/tab audio capture is disabled to keep large classes stable.',
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

            this.screenStream.getVideoTracks()[0].onended = () => this.stopScreenShare();

            // Add tracks to all existing peer connections (presenter + other students)
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

            // Notify everyone in the room to connect to this student
            this.socket.emit('student-screen-share-started', { roomId: this.roomId });
            
        } catch (e) { 
            console.error("Screen share error:", e);
            alert('Failed to start screen sharing');
        }
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        
        const video = document.getElementById('mainVideo');
        if (this.presenterStream) {
            this.showRemoteStream(this.presenterStream);
            video.style.display = 'block';
            document.getElementById('waitingMessage').style.display = 'none';
        } else {
            video.srcObject = null;
            video.muted = false;
            document.getElementById('waitingMessage').style.display = 'flex';
        }
        
        // Notify others in room
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
        this.isSharing = false;
    }

    async connectToPeer(peerId) {
        if (this.peerConnections.has(peerId)) return;
        
        const connectionStartTime = Date.now();
        const pc = webrtcUtils.createPeerConnection(); // Use optimized WebRTC configuration
        this.peerConnections.set(peerId, pc);

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => pc.addTrack(t, this.screenStream));
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => pc.addTrack(t, this.micStream));
        }

        this.applySenderParametersForPeer(pc).catch(() => {});

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('ice-candidate', { target: peerId, candidate: e.candidate });
        };

        pc.ontrack = (e) => {
            this.handleIncomingTrack(peerId, e);
        };

        // Add performance monitoring when connection is established
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(peerId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(peerId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(peerId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(peerId);
            }
        };

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                console.warn(`Connection timeout for peer ${peerId}`);
                this.logConnectionFailure(peerId, 'timeout');
            }
        }, 15000); // 15 second timeout

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
        
        // Clear timeout when connection is established or fails
        pc.onconnectionstatechange = () => {
            if (pc.connectionState !== 'connecting' && pc.connectionState !== 'new') {
                clearTimeout(connectionTimeout);
            }
            
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(peerId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(peerId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(peerId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(peerId);
            }
        };
    }

    // Log connection performance metrics
    async logConnectionPerformance(peerId, connectionTime) {
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
                        participantId: this.socketId,
                        logType: 'connection',
                        message: `Connected to ${peerId} in ${connectionTime}ms`,
                        metrics: performanceData
                    })
                });
            }

            console.log(`Connection Performance - Peer ${peerId}: ${connectionTime}ms`);
        } catch (error) {
            console.error('Error logging connection performance:', error);
        }
    }

    // Log connection failure
    async logConnectionFailure(peerId, failureReason) {
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
                        participantId: this.socketId,
                        logType: 'error',
                        message: `Connection to ${peerId} failed: ${failureReason}`,
                        metrics: performanceData
                    })
                });
            }

            console.warn(`Connection Failure - Peer ${peerId}: ${failureReason}`);
        } catch (error) {
            console.error('Error logging connection failure:', error);
        }
    }

    // Start performance monitoring for a connection
    startPerformanceMonitoring(peerId, peerConnection) {
        if (!this.shouldMonitorPeerPerformance()) {
            return;
        }

        const stopMonitoring = webrtcUtils.monitorPerformance(peerConnection, (performanceData) => {
            // Log performance data periodically
            this.logPerformanceMetrics(peerId, performanceData);
        });

        // Store stop function for cleanup
        this.performanceMonitors.set(peerId, stopMonitoring);
    }

    // Stop performance monitoring for a connection
    stopPerformanceMonitoring(peerId) {
        const stopMonitoring = this.performanceMonitors.get(peerId);
        if (stopMonitoring) {
            stopMonitoring();
            this.performanceMonitors.delete(peerId);
        }
    }

    // Log performance metrics to database
    async logPerformanceMetrics(peerId, performanceData) {
        try {
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: this.socketId,
                        logType: 'performance',
                        message: `Performance with ${peerId}: ${performanceData.bandwidth.toFixed(2)}kbps, ${performanceData.latency.toFixed(2)}ms latency`,
                        metrics: performanceData
                    })
                });
            }
        } catch (error) {
            console.error('Error logging performance metrics:', error);
        }
    }

    async handleOffer(data) {
        let pc = this.peerConnections.get(data.sender);
        if (!pc) {
            pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
            this.peerConnections.set(data.sender, pc);
            
            pc.onicecandidate = (e) => {
                if (e.candidate) this.socket.emit('ice-candidate', { target: data.sender, candidate: e.candidate });
            };

            pc.ontrack = (e) => {
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

        if (peerId === this.presenterId) {
            this.presenterStream = mergedStream;
        }

        if (track.kind === 'audio') {
            this.attachRemoteAudioTrack(track);
        }

        if (track.kind === 'video') {
            this.showRemoteStream(mergedStream);
            if (peerId === this.presenterId) {
                document.getElementById('waitingMessage').style.display = 'none';
            }
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

    updateDiscoveryList(room) {
        const list = document.getElementById('availableRooms');
        const existing = document.getElementById(`room-${room.roomId}`);
        if (!existing) {
            // FILTER: If student has a link, only show that room
            const urlParams = new URLSearchParams(window.location.search);
            const urlRoomId = urlParams.get('room');
            if (urlRoomId && room.roomId !== urlRoomId) return;

            const div = document.createElement('div');
            div.id = `room-${room.roomId}`;
            div.className = 'room-card-tiny';
            div.innerHTML = `<span>${room.details.topic}</span> <button class="btn btn-primary" onclick="autoJoin('${room.roomId}')">Join</button>`;
            list.appendChild(div);
        }
    }

    displayPresenterDetails(details) {
        const overlay = document.getElementById('presenterInfoOverlay');
        overlay.innerHTML = `<strong>Lecture:</strong> ${details.topic} <span style="opacity:0.6; margin:0 8px;">•</span> <strong>Presenter:</strong> ${details.name}`;
        overlay.style.display = 'block';
    }

    updateParticipantsUI(participants) {
        const list = document.getElementById('studentGrid');
        document.getElementById('studentCount').textContent = participants.length;
        this.audienceSize = participants.length + 1;
        list.innerHTML = participants.map(p => `
            <div class="participant-chip ${p.socketId === this.socketId ? 'highlight-me' : ''}">
                <div class="avatar">${p.name.charAt(0).toUpperCase()}</div>
                <div class="p-name">${p.name} ${p.socketId === this.socketId ? '(You)' : ''}</div>
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
        this.activeQualityProfile = profile;

        try {
            await track.applyConstraints({
                width: { ideal: profile.width, max: profile.width },
                height: { ideal: profile.height, max: profile.height },
                frameRate: { ideal: profile.frameRate, max: profile.frameRate }
            });
        } catch (error) {
            // Continue with sender parameter tuning if constraints are rejected.
        }

        await Promise.all(
            Array.from(this.peerConnections.values()).map((pc) =>
                this.applySenderParametersForPeer(pc)
            )
        );
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
            // Ignore sender tuning errors.
        }
    }

    // Chat methods
    sendChatMessage(message) {
        if (!message.trim() || !this.roomId) {
            console.log('Student sendChatMessage blocked:', { message: message.trim(), roomId: this.roomId, studentName: this.studentName });
            return;
        }
        
        const chatData = {
            roomId: this.roomId,
            senderName: this.studentName || 'Student',
            message: message.trim(),
            role: 'student',
            timestamp: new Date().toISOString()
        };
        
        console.log('Student sending chat data:', chatData);
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

    leaveSession() {
        this.saveCredentials({
            name: this.studentName || document.getElementById('studentName')?.value?.trim() || '',
            roomId: this.roomId || document.getElementById('joinRoomId')?.value?.trim() || ''
        });
        if (this.socket) {
            this.socket.disconnect();
        }
        // Clear all session data
        this.roomId = null;
        this.studentName = null;
        this.isActive = false;
        this.cleanup();
        
        // Return to role selection
        location.reload();
    }

    showSessionEndedNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #dc3545;
            color: white;
            padding: 2rem;
            border-radius: 12px;
            z-index: 10000;
            font-family: system-ui, -apple-system, sans-serif;
            text-align: center;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            max-width: 400px;
        `;
        notification.innerHTML = `
            <h2 style="color: white; margin-bottom: 20px; font-size: 1.5rem;">🔴 Session Ended</h2>
            <p style="font-size: 1.1rem; text-align: center; margin-bottom: 20px;">
                ${message}
            </p>
            <p style="font-size: 0.9rem; opacity: 0.8;">
                You will be redirected to the main screen...
            </p>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remove after 3 seconds
        setTimeout(() => {
            const notif = document.getElementById('sessionEndedNotification');
            if (notif) notif.remove();
        }, 3000);
    }

    // Focus Detection Methods
    showFocusPolicyNotification() {
        const notification = document.createElement('div');
        notification.id = 'focusPolicyNotification';
        notification.innerHTML = `
            <div style="
                position: fixed;
                top: 20px;
                right: 20px;
                background: #333399;
                color: white;
                padding: 16px 20px;
                border-radius: 12px;
                border-left: 4px solid #FCB900;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 9999;
                max-width: 350px;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                    <span style="font-size: 1.2rem; margin-right: 8px;">📚</span>
                    <strong style="color: #FCB900;">Focus Policy Active</strong>
                </div>
                <p style="margin: 0; font-size: 0.9rem; line-height: 1.4;">
                    For the best learning experience, please stay focused on this lecture. Switching to other apps will automatically disconnect you from the session.
                </p>
                <button onclick="this.parentElement.parentElement.remove()" style="
                    background: #FCB900;
                    color: #333399;
                    border: none;
                    padding: 6px 12px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    border-radius: 6px;
                    cursor: pointer;
                    margin-top: 12px;
                ">
                    I Understand
                </button>
            </div>
        `;
        
        document.body.appendChild(notification);

        
        // Auto-remove after 10 seconds
        setTimeout(() => {
            const notif = document.getElementById('focusPolicyNotification');
            if (notif) notif.remove();
        }, 10000);
    }

    initializeFocusDetection() {
        // Page Visibility API
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.handlePageHidden();
            } else {
                this.handlePageVisible();
            }
        });

        // Window focus/blur events
        window.addEventListener('blur', () => {
            this.handleWindowBlur();
        });

        window.addEventListener('focus', () => {
            this.handleWindowFocus();
        });

        // Before unload event
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    handlePageHidden() {
        if (!this.isActive || !this.roomId) return;
        
        console.log('Student page hidden - starting logout process');
        this.showWarning();
        
        // Clear any existing timeouts
        if (this.warningTimeout) clearTimeout(this.warningTimeout);
        if (this.logoutTimeout) clearTimeout(this.logoutTimeout);
        
        // Show warning for 3 seconds, then logout
        this.warningTimeout = setTimeout(() => {
            this.forceLogout();
        }, 5000);
    }

    handlePageVisible() {
        if (!this.isActive || !this.roomId) return;
        
        console.log('Student page visible - cancelling logout');
        this.hideWarning();
        
        // Clear timeouts if student returns within warning period
        if (this.warningTimeout) {
            clearTimeout(this.warningTimeout);
            this.warningTimeout = null;
        }
        if (this.logoutTimeout) {
            clearTimeout(this.logoutTimeout);
            this.logoutTimeout = null;
        }
    }

    handleWindowBlur() {
        // Additional check for window losing focus
        setTimeout(() => {
            if (document.hidden && this.isActive && this.roomId) {
                this.handlePageHidden();
            }
        }, 100);
    }

    handleWindowFocus() {
        if (this.isActive && this.roomId) {
            this.handlePageVisible();
        }
    }

    showWarning() {
        // Create warning overlay
        const warning = document.createElement('div');
        warning.id = 'focusWarning';
        warning.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                color: white;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <h2 style="color: #FCB900; margin-bottom: 20px;">⚠️ Attention Required!</h2>
                <p style="font-size: 1.2rem; text-align: center; max-width: 400px; margin-bottom: 20px;">
                    Please stay focused on the lecture. Switching to other apps will disconnect you from the session.
                </p>
                <p style="font-size: 1rem; opacity: 0.8;">
                    Return to this window immediately to continue...
                </p>
                <div style="margin-top: 30px;">
                    <div style="width: 60px; height: 60px; border: 4px solid #FCB900; border-top: 4px solid transparent; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                </div>
            </div>
        `;
        
        // Add spinning animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(warning);
    }

    hideWarning() {
        const warning = document.getElementById('focusWarning');
        if (warning) {
            warning.remove();
        }
    }

    forceLogout() {
        console.log('Force logging out student due to inactivity');
        this.saveCredentials({
            name: this.studentName || document.getElementById('studentName')?.value?.trim() || '',
            roomId: this.roomId || document.getElementById('joinRoomId')?.value?.trim() || ''
        });
        this.hideWarning();
        this.cleanup();
        
        // Show logout message
        const logoutMessage = document.createElement('div');
        logoutMessage.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: #333399;
                color: white;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <h2 style="color: #FCB900; margin-bottom: 20px;">Session Ended</h2>
                <p style="font-size: 1.2rem; text-align: center; max-width: 400px; margin-bottom: 30px;">
                    You were disconnected for switching to other applications. Please stay focused during lectures.
                </p>
                <button onclick="location.reload()" style="
                    background: #FCB900;
                    color: #333399;
                    border: none;
                    padding: 12px 24px;
                    font-size: 1rem;
                    font-weight: 600;
                    border-radius: 8px;
                    cursor: pointer;
                ">
                    Rejoin Session
                </button>
            </div>
        `;
        
        document.body.innerHTML = '';
        document.body.appendChild(logoutMessage);
        
        // Disconnect from server
        if (this.socket) {
            this.socket.disconnect();
        }
    }

    cleanup() {
        this.isActive = false;
        if (this.warningTimeout) {
            clearTimeout(this.warningTimeout);
            this.warningTimeout = null;
        }
        if (this.logoutTimeout) {
            clearTimeout(this.logoutTimeout);
            this.logoutTimeout = null;
        }
        this.hideWarning();
    }
}

const student = new Student();
function joinRoom() { student.joinRoom(); }
function autoJoin(id) { 
    const joinRoomField = document.getElementById('joinRoomId');
    joinRoomField.value = id;
    joinRoomField.setAttribute('readonly', true);
    student.joinRoom(); 
}
