// Main application controller
class ScreenMirroringApp {
    constructor() {
        this.currentRole = null;
        this.isMuted = true;
        this.isSharing = false;
        this.unreadMessages = 0;
        this.clientConfigPromise = null;
        this.sessionStartedAt = null;
        this.sessionTimerInterval = null;
        this.checkUrlParams();
    }

    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomId = urlParams.get('room');
        if (roomId) {
            setTimeout(() => {
                this.selectRole('student');
                const joinRoomField = document.getElementById('joinRoomId');
                joinRoomField.value = roomId;
                joinRoomField.setAttribute('readonly', true);
                
                // Hide discovery section if joining via link
                const discovery = document.getElementById('discoverySection');
                if (discovery) discovery.style.display = 'none';
            }, 800);
        }
    }

    selectRole(role) {
        this.currentRole = role;
        document.getElementById('roleSelector').style.display = 'none';
        document.getElementById('mainApp').style.display = 'grid'; // Changed from block to grid

        if (role === 'presenter') {
            document.getElementById('presenterSetup').style.display = 'flex';
            presenter.initializeSocket();
        } else {
            document.getElementById('studentSetup').style.display = 'flex';
            student.initializeSocket();
        }
    }

    updateSessionUI(roomId, status) {
        document.getElementById('activeSessionInfo').style.display = 'flex';
        document.getElementById('displayRoomId').textContent = `Room: ${roomId}`;
        document.getElementById('connectionStatusText').textContent = status;
        
        // Show action bar
        const actionBar = document.querySelector('.action-bar');
        if (actionBar) actionBar.style.display = 'flex';
        
        this.renderHeaderActions();
        
        // Hide setup overlays
        document.getElementById('presenterSetup').style.display = 'none';
        document.getElementById('studentSetup').style.display = 'none';
        
        if (this.currentRole === 'presenter') {
            document.getElementById('shareLinkContainer').style.display = 'block';
            document.getElementById('shareLinkInput').value = `${window.location.origin}/?room=${roomId}`;
        }

        this.startSessionTimer();
    }

    formatSessionDuration(totalSeconds) {
        const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
        const hours = String(Math.floor(safeSeconds / 3600)).padStart(2, '0');
        const minutes = String(Math.floor((safeSeconds % 3600) / 60)).padStart(2, '0');
        const seconds = String(safeSeconds % 60).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    renderSessionTimer() {
        const timerContainer = document.getElementById('sessionTimer');
        const timerDisplay = document.getElementById('timerDisplay');
        if (!timerContainer || !timerDisplay || !this.sessionStartedAt) return;

        const elapsedSeconds = Math.floor((Date.now() - this.sessionStartedAt) / 1000);
        timerDisplay.textContent = this.formatSessionDuration(elapsedSeconds);
        timerContainer.style.display = 'flex';
    }

    startSessionTimer(startTime = Date.now()) {
        this.sessionStartedAt = Number(startTime) || Date.now();
        this.stopSessionTimer(false);
        this.renderHeaderActions();
        this.renderSessionTimer();
        this.sessionTimerInterval = window.setInterval(() => {
            this.renderSessionTimer();
        }, 1000);
    }

    stopSessionTimer(resetDisplay = true) {
        if (this.sessionTimerInterval) {
            window.clearInterval(this.sessionTimerInterval);
            this.sessionTimerInterval = null;
        }

        if (resetDisplay) {
            this.sessionStartedAt = null;
            const timerContainer = document.getElementById('sessionTimer');
            const timerDisplay = document.getElementById('timerDisplay');
            if (timerContainer) timerContainer.style.display = 'none';
            if (timerDisplay) timerDisplay.textContent = '00:00:00';
        }
    }

    renderHeaderActions() {
        const headerActions = document.querySelector('.header-actions');
        const timerContainer = document.getElementById('sessionTimer');
        if (!headerActions) return;

        headerActions.innerHTML = '';

        if (timerContainer) {
            headerActions.appendChild(timerContainer);
            timerContainer.style.display = this.sessionStartedAt ? 'flex' : 'none';
        }

        if (!this.currentRole) return;

        const actionButton = document.createElement('button');
        actionButton.className = 'btn btn-danger';

        if (this.currentRole === 'presenter') {
            actionButton.textContent = 'End Session';
            actionButton.onclick = endSession;
        } else if (this.currentRole === 'student') {
            actionButton.textContent = 'Leave Session';
            actionButton.onclick = leaveSession;
        } else {
            return;
        }

        headerActions.appendChild(actionButton);
    }

    async getClientConfig() {
        if (!this.clientConfigPromise) {
            this.clientConfigPromise = fetch('/api/client-config')
                .then((response) => {
                    if (!response.ok) {
                        throw new Error('Failed to load client config');
                    }
                    return response.json();
                })
                .catch(() => {
                    return {
                        socketServerUrl: window.location.hostname !== 'localhost'
                            ? `http://${window.location.hostname}:3001`
                            : 'http://localhost:3001'
                    };
                });
        }

        return this.clientConfigPromise;
    }
}

const app = new ScreenMirroringApp();

function updateScaleModeBanner(scaleData) {
    const banner = document.getElementById('scaleModeBanner');
    if (!banner || !scaleData) return;

    const level = scaleData.level || 'small';
    const count = scaleData.participantCount || 1;
    const recommendation = scaleData.recommendation || '';

    if (level === 'small') {
        banner.style.display = 'none';
        banner.className = 'scale-mode-banner';
        banner.textContent = '';
        return;
    }

    banner.className = `scale-mode-banner level-${level}`;
    banner.textContent = `Class size: ${count} participants. ${recommendation}`;
    banner.style.display = 'block';
}

const ACTION_ICONS = {
    mic: `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
    `,
    micMuted: `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v6"></path>
            <path d="M15 8.5V4a3 3 0 0 0-3-3"></path>
            <path d="M19 10v2a7 7 0 0 1-11.2 5.6"></path>
            <path d="M5 10v2a7 7 0 0 0 7 7"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
            <line x1="4" y1="4" x2="20" y2="20"></line>
        </svg>
    `,
    share: `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
            <polyline points="16 10 12 6 8 10"></polyline>
            <line x1="12" y1="6" x2="12" y2="14"></line>
        </svg>
    `
};

function renderActionButton(buttonId, iconMarkup, tooltip) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    btn.innerHTML = `${iconMarkup}<span class="tooltip">${tooltip}</span>`;
    btn.title = tooltip;
    btn.setAttribute('aria-label', tooltip);
}

function syncActionButtons() {
    renderActionButton('muteBtn', app.isMuted ? ACTION_ICONS.micMuted : ACTION_ICONS.mic, app.isMuted ? 'Turn on microphone' : 'Turn off microphone');
    renderActionButton('shareBtn', ACTION_ICONS.share, app.isSharing ? 'Stop sharing' : 'Share screen');

    const muteBtn = document.getElementById('muteBtn');
    const shareBtn = document.getElementById('shareBtn');

    if (muteBtn) {
        muteBtn.classList.toggle('active', app.isMuted);
        muteBtn.classList.toggle('muted', app.isMuted);
    }

    if (shareBtn) {
        shareBtn.classList.toggle('active', app.isSharing);
    }
}

function selectRole(role) { app.selectRole(role); }

function quickJoinFromLanding() {
    const roomCodeInput = document.getElementById('landingRoomCode');
    const roomCode = roomCodeInput ? roomCodeInput.value.trim().toUpperCase() : '';

    app.selectRole('student');

    setTimeout(() => {
        const joinRoomField = document.getElementById('joinRoomId');
        if (!joinRoomField) return;

        joinRoomField.removeAttribute('readonly');
        if (roomCode) {
            joinRoomField.value = roomCode;
        }
        joinRoomField.focus();
    }, 120);
}

function endSession() {
    if (presenter && presenter.roomId) {
        app.stopSessionTimer();
        presenter.endSession();
    }
}

function leaveSession() {
    if (student && student.roomId) {
        app.stopSessionTimer();
        student.leaveSession();
    }
}

// GLOBAL BRIDGES
function toggleMute() {
    app.isMuted = !app.isMuted;
    
    if (app.currentRole === 'presenter') {
        presenter.toggleMic(!app.isMuted);
    } else {
        student.toggleMic(!app.isMuted);
    }
    
    syncActionButtons();
}

async function toggleShare() {
    if (app.currentRole === 'presenter') {
        if (!app.isSharing) {
            await presenter.startScreenShare();
            app.isSharing = true;
        } else {
            presenter.stopScreenShare();
            app.isSharing = false;
        }
    } else {
        if (!app.isSharing) {
            await student.startScreenShare();
            app.isSharing = true;
        } else {
            student.stopScreenShare();
            app.isSharing = false;
        }
    }

    syncActionButtons();
}

function toggleFullscreen() {
    const container = document.querySelector('.video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
}

function toggleChat() {
    const chatPanel = document.getElementById('chatPanel');
    const chatBtn = document.getElementById('chatBtn');
    
    if (chatPanel) {
        const isVisible = chatPanel.style.display !== 'none';
        chatPanel.style.display = isVisible ? 'none' : 'flex';
        
        // Update button active state
        if (chatBtn) {
            chatBtn.classList.toggle('active', !isVisible);
        }
        
        // Focus input when opening
        if (!isVisible) {
            setTimeout(() => {
                const chatInput = document.getElementById('floatingChatInput');
                if (chatInput) chatInput.focus();
            }, 100);
        }
        
        // Clear notification badge when opening chat
        if (!isVisible) {
            clearChatNotificationBadge();
        }
    }
}

// Typing indicator timeout
let typingTimeout = null;
function handleTyping() {
    // Clear existing timeout
    if (typingTimeout) {
        clearTimeout(typingTimeout);
    }
    
    // Get user info
    const userName = app.currentRole === 'presenter' ? 
        'Host' : 
        document.getElementById('studentName')?.value || 'Student';
    
    // Get room ID
    let roomId = null;
    if (app.currentRole === 'presenter') {
        roomId = presenter.roomId || presenter.room;
    } else {
        roomId = student.roomId || student.room;
    }
    
    if (!roomId) return;
    
    const socket = app.currentRole === 'presenter' ? presenter.socket : student.socket;
    if (socket) {
        socket.emit('typing', { sender: userName, roomId: roomId });
    }
    
    // Clear typing indicator after 2 seconds
    typingTimeout = setTimeout(() => {
        if (socket) {
            socket.emit('stop-typing', { sender: userName, roomId: roomId });
        }
    }, 2000);
}

function showTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.style.display = 'flex';
        // Auto-hide after 3 seconds
        setTimeout(() => {
            indicator.style.display = 'none';
        }, 3000);
    }
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}

function clearChatNotificationBadge() {
    const chatBtn = document.getElementById('chatBtn');
    app.unreadMessages = 0;
    if (chatBtn) {
        const badge = chatBtn.querySelector('.chat-badge');
        if (badge) badge.remove();
    }
}

function addChatNotificationBadge() {
    const chatBtn = document.getElementById('chatBtn');
    const chatPanel = document.getElementById('chatPanel');
    
    // Only show badge if chat is closed
    if (chatBtn && chatPanel && chatPanel.style.display === 'none') {
        let badge = chatBtn.querySelector('.chat-badge');
        app.unreadMessages += 1;

        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'chat-badge';
            chatBtn.appendChild(badge);
        }

        badge.textContent = app.unreadMessages > 99 ? '99+' : String(app.unreadMessages);
    }
}

function sendChatMessage() {
    const chatInput = document.getElementById('floatingChatInput');
    const chatMessages = document.getElementById('floatingChatMessages');
    
    if (!chatInput || !chatMessages) {
        console.error('Chat elements not found');
        return;
    }
    
    const message = chatInput.value.trim();
    if (!message) return;
    
    // Get user info
    const userName = app.currentRole === 'presenter' ? 
        'Host' : 
        document.getElementById('studentName')?.value || 'Student';
    
    // Get room ID - CRITICAL for message delivery
    let roomId = null;
    if (app.currentRole === 'presenter') {
        roomId = presenter.roomId || presenter.room;
    } else {
        roomId = student.roomId || student.room;
    }
    
    if (!roomId) {
        console.error('No room ID found - cannot send message');
        alert('Please join a room first before sending messages');
        return;
    }
    
    // Get current time
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Display own message immediately
    const displayData = {
        text: message,
        sender: userName,
        timestamp: timeString,
        isOwn: true
    };
    displayChatMessage(displayData);
    
    // Clear input
    chatInput.value = '';
    chatInput.focus();
    
    // Prepare data for server - MUST include roomId
    const serverData = {
        text: message,
        sender: userName,
        timestamp: timeString,
        roomId: roomId
    };
    
    // Send via socket.io
    const socket = app.currentRole === 'presenter' ? presenter.socket : student.socket;
    if (socket) {
        console.log('Emitting chat-message to room:', roomId, 'Data:', serverData);
        socket.emit('chat-message', serverData);
    } else {
        console.error('Socket not connected - message not sent to server');
    }
}

function displayChatMessage(messageData) {
    const chatMessages = document.getElementById('floatingChatMessages');
    if (!chatMessages) return;
    
    // Remove welcome message if it exists
    const welcomeMsg = chatMessages.querySelector('.chat-welcome');
    if (welcomeMsg) welcomeMsg.remove();
    
    // Create message element
    const messageDiv = document.createElement('div');
    messageDiv.className = messageData.isOwn ? 'chat-message own' : 'chat-message other';
    
    const authorName = messageData.isOwn ? 'You' : messageData.sender;
    
    messageDiv.innerHTML = `
        <div class="chat-message-header">
            <span class="chat-message-author">${escapeHtml(authorName)}</span>
            <span class="chat-message-time">${messageData.timestamp}</span>
        </div>
        <div class="chat-message-text">${escapeHtml(messageData.text)}</div>
    `;
    
    // Add to chat with animation
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize chat listeners when socket connects
function initializeChatListeners(socket) {
    if (!socket) return;
    
    // Note: chat-message listener is already set up in presenter.js and student.js
    // to avoid duplicates. Only typing indicators are handled here.
    
    // Listen for typing indicators
    socket.on('typing', () => {
        showTypingIndicator();
    });
    
    socket.on('stop-typing', () => {
        hideTypingIndicator();
    });
}

function openFeedbackModal() {
    const userEmail = app.currentRole === 'presenter'
        ? document.getElementById('presEmail')?.value?.trim() || null
        : document.getElementById('studentEmail')?.value || null;
    
    const userName = app.currentRole === 'presenter'
        ? document.getElementById('presName')?.value || 'Host'
        : document.getElementById('studentName')?.value || 'Student';
    
    window.feedbackUserInfo = {
        email: userEmail,
        name: userName,
        role: app.currentRole || 'student'
    };
    
    document.getElementById('feedbackModal').style.display = 'flex';
    resetFeedbackRating();
    updateFeedbackConnectivityStatus();
}

function closeFeedbackModal() {
    document.getElementById('feedbackModal').style.display = 'none';
    resetFeedbackRating();
}

function resetFeedbackRating() {
    const issueType = document.getElementById('feedbackIssueType');
    const message = document.getElementById('feedbackMessageInput');
    const screenshotInput = document.getElementById('feedbackScreenshotInput');
    const screenshotName = document.getElementById('feedbackScreenshotName');
    const screenshotPreview = document.getElementById('feedbackScreenshotPreview');
    const submitBtn = document.getElementById('submitRatingBtn');
    const messageBox = document.getElementById('feedbackMessage');
    const ratingText = document.getElementById('feedbackRatingText');

    window.feedbackScreenshotData = null;
    window.feedbackSelectedRating = 0;

    if (issueType) issueType.value = '';
    if (message) message.value = '';
    if (screenshotInput) screenshotInput.value = '';
    if (screenshotName) screenshotName.textContent = 'No screenshot selected';
    if (screenshotPreview) {
        screenshotPreview.removeAttribute('src');
        screenshotPreview.style.display = 'none';
    }
    if (messageBox) messageBox.innerHTML = '';
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Report';
    }
    if (ratingText) {
        ratingText.textContent = 'Choose a rating before sending.';
    }

    document.querySelectorAll('#feedbackRatingGroup .rating-star').forEach((star) => {
        star.classList.remove('active');
        star.setAttribute('aria-checked', 'false');
    });
}

function getFeedbackRatingLabel(rating) {
    return {
        1: 'Very poor',
        2: 'Poor',
        3: 'Fair',
        4: 'Good',
        5: 'Excellent'
    }[rating] || 'Choose a rating before sending.';
}

function paintFeedbackStars(rating) {
    const stars = document.querySelectorAll('#feedbackRatingGroup .rating-star');
    stars.forEach((star) => {
        const starRating = Number(star.dataset.rating);
        const active = starRating <= rating;
        star.classList.toggle('active', active);
        star.setAttribute('aria-checked', starRating === rating ? 'true' : 'false');
    });
}

function setFeedbackRating(rating) {
    window.feedbackSelectedRating = Number(rating) || 0;
    paintFeedbackStars(window.feedbackSelectedRating);

    const ratingText = document.getElementById('feedbackRatingText');
    if (ratingText) {
        ratingText.textContent = getFeedbackRatingLabel(window.feedbackSelectedRating);
    }
}

function previewFeedbackRating(rating) {
    paintFeedbackStars(Number(rating) || 0);

    const ratingText = document.getElementById('feedbackRatingText');
    if (ratingText) {
        ratingText.textContent = getFeedbackRatingLabel(Number(rating) || 0);
    }
}

function restoreFeedbackRatingPreview() {
    paintFeedbackStars(window.feedbackSelectedRating || 0);

    const ratingText = document.getElementById('feedbackRatingText');
    if (ratingText) {
        ratingText.textContent = getFeedbackRatingLabel(window.feedbackSelectedRating || 0);
    }
}

function initializeFeedbackRating() {
    const stars = document.querySelectorAll('#feedbackRatingGroup .rating-star');
    if (!stars.length) return;

    stars.forEach((star) => {
        const rating = Number(star.dataset.rating);
        if (star.dataset.bound === 'true') {
            return;
        }

        star.dataset.bound = 'true';
        star.addEventListener('click', () => setFeedbackRating(rating));
        star.addEventListener('mouseenter', () => previewFeedbackRating(rating));
        star.addEventListener('focus', () => previewFeedbackRating(rating));
        star.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setFeedbackRating(rating);
            }
        });
    });

    const ratingGroup = document.getElementById('feedbackRatingGroup');
    if (ratingGroup && ratingGroup.dataset.bound !== 'true') {
        ratingGroup.dataset.bound = 'true';
        ratingGroup.addEventListener('mouseleave', restoreFeedbackRatingPreview);
    }

    restoreFeedbackRatingPreview();
}

function updateFeedbackConnectivityStatus() {
    const indicator = document.getElementById('feedbackConnectivity');
    if (!indicator) return;

    if (navigator.onLine) {
        indicator.className = 'feedback-connectivity online';
        indicator.textContent = 'Online: your report can be sent now.';
    } else {
        indicator.className = 'feedback-connectivity offline';
        indicator.textContent = 'Offline: please go online before sending your report.';
    }
}

function handleFeedbackScreenshotChange(event) {
    const file = event.target.files?.[0];
    const screenshotName = document.getElementById('feedbackScreenshotName');
    const screenshotPreview = document.getElementById('feedbackScreenshotPreview');

    if (!file) {
        window.feedbackScreenshotData = null;
        if (screenshotName) screenshotName.textContent = 'No screenshot selected';
        if (screenshotPreview) {
            screenshotPreview.removeAttribute('src');
            screenshotPreview.style.display = 'none';
        }
        return;
    }

    if (screenshotName) {
        screenshotName.textContent = file.name;
    }

    const reader = new FileReader();
    reader.onload = () => {
        window.feedbackScreenshotData = {
            name: file.name,
            type: file.type,
            data: reader.result
        };

        if (screenshotPreview) {
            screenshotPreview.src = reader.result;
            screenshotPreview.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
}

async function submitRating() {
    const issueType = document.getElementById('feedbackIssueType')?.value;
    const description = document.getElementById('feedbackMessageInput')?.value.trim();
    const submitBtn = document.getElementById('submitRatingBtn');
    const messageDiv = document.getElementById('feedbackMessage');
    const rating = window.feedbackSelectedRating || 0;
    
    if (!navigator.onLine) {
        messageDiv.innerHTML = `
            <div class="error-message">
                You are offline. Please go online first, then send your issue report.
            </div>
        `;
        return;
    }

    if (!issueType || !description) {
        messageDiv.innerHTML = `
            <div class="error-message">
                Please choose what you were trying to do and describe the issue before sending.
            </div>
        `;
        return;
    }

    if (!rating) {
        messageDiv.innerHTML = `
            <div class="error-message">
                Please choose your own star rating before sending.
            </div>
        `;
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
    
    try {
        const response = await fetch('/api/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: window.feedbackUserInfo?.email || null,
                name: window.feedbackUserInfo?.name || null,
                role: window.feedbackUserInfo?.role || app.currentRole || 'student',
                sessionId: app.roomId || null,
                rating,
                issueType,
                description,
                screenshot: window.feedbackScreenshotData || null
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            messageDiv.innerHTML = `
                <div class="success-message">
                    Your issue report was sent successfully.
                </div>
            `;
            
            setTimeout(() => {
                closeFeedbackModal();
            }, 1800);
        } else {
            throw new Error(result.error || 'Failed to submit feedback');
        }
    } catch (error) {
        console.error('Error submitting rating:', error);
        messageDiv.innerHTML = `
            <div class="error-message">
                Failed to submit the report: ${error.message}. Please try again.
            </div>
        `;
        
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Report';
    }
}

document.addEventListener('DOMContentLoaded', initializeFeedbackRating);

function initializeContentProtection() {
    if (window.MustMirrorSecurity && typeof window.MustMirrorSecurity.protectPage === 'function') {
        window.MustMirrorSecurity.protectPage();
        return;
    }

    const blockedKeyCombos = new Set(['a', 'c', 'p', 's', 'u', 'v', 'x']);
    const blockedInspectorCombos = new Set(['c', 'i', 'j', 'k']);
    const blockEvent = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }
    };

    ['contextmenu', 'copy', 'cut', 'paste', 'selectstart', 'dragstart'].forEach((eventName) => {
        document.addEventListener(eventName, blockEvent, true);
    });

    document.addEventListener('keydown', (event) => {
        const key = (event.key || '').toLowerCase();
        const hasCtrlOrMeta = event.ctrlKey || event.metaKey;

        if (key === 'f12' || key === 'printscreen') {
            blockEvent(event);
            return;
        }

        if (hasCtrlOrMeta && blockedKeyCombos.has(key)) {
            blockEvent(event);
            return;
        }

        if (hasCtrlOrMeta && event.shiftKey && blockedInspectorCombos.has(key)) {
            blockEvent(event);
            return;
        }

        if (hasCtrlOrMeta && event.altKey && (key === 'i' || key === 'u')) {
            blockEvent(event);
        }
    }, true);
}

function initializeChatScrollSupport() {
    const chatInput = document.getElementById('floatingChatInput');
    const chatMessages = document.getElementById('floatingChatMessages');
    if (!chatInput || !chatMessages) return;

    chatInput.addEventListener('focus', () => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

async function openConnectivityHelpModal() {
    const modal = document.getElementById('connectivityHelpModal');
    const addressList = document.getElementById('connectivityAddressList');
    if (!modal || !addressList) return;

    modal.style.display = 'flex';
    addressList.innerHTML = '<p>Loading host addresses...</p>';

    try {
        const response = await fetch('/api/network-info');
        if (!response.ok) {
            throw new Error('Failed to load host network info');
        }

        const data = await response.json();
        const addresses = Array.isArray(data.addresses) ? data.addresses : [];

        if (!addresses.length) {
            addressList.innerHTML = `
                <p>No external host address detected.</p>
                <p>Use this device URL manually: <strong>${window.location.origin}</strong></p>
            `;
            return;
        }

        addressList.innerHTML = addresses.map((entry) => `
            <div class="connectivity-address-item">
                <span><strong>${entry.interface}</strong> - ${entry.ip}</span>
                <div class="connectivity-address-actions">
                    <a href="${entry.url}" target="_blank" rel="noopener">${entry.url}</a>
                    <button class="btn btn-secondary connectivity-copy-btn" onclick="copyHostUrl('${entry.url}', this)">Copy host URL</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        addressList.innerHTML = `
            <p>Could not load host addresses automatically.</p>
            <p>Use this URL on student devices: <strong>${window.location.origin}</strong></p>
        `;
    }
}

function closeConnectivityHelpModal() {
    const modal = document.getElementById('connectivityHelpModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function copyHostUrl(url, triggerButton) {
    if (!url) return;

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(url);
        } else {
            const tempInput = document.createElement('input');
            tempInput.value = url;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand('copy');
            document.body.removeChild(tempInput);
        }

        if (triggerButton) {
            const previousText = triggerButton.textContent;
            triggerButton.textContent = 'Copied';
            triggerButton.disabled = true;
            setTimeout(() => {
                triggerButton.textContent = previousText;
                triggerButton.disabled = false;
            }, 1200);
        }
    } catch (error) {
        alert(`Copy failed. Use this URL manually: ${url}`);
    }
}

initializeContentProtection();
initializeChatScrollSupport();
syncActionButtons();
