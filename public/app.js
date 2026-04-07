// Main application controller
class ScreenMirroringApp {
    constructor() {
        this.currentRole = null;
        this.isMuted = true;
        this.isSharing = false;
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
        
        // Update header button based on role
        const headerActions = document.querySelector('.header-actions');
        if (this.currentRole === 'presenter') {
            headerActions.innerHTML = '<button class="btn btn-danger" onclick="endSession()">End Session</button>';
        } else if (this.currentRole === 'student') {
            headerActions.innerHTML = '<button class="btn btn-danger" onclick="leaveSession()">Leave Session</button>';
        }
        
        // Hide setup overlays
        document.getElementById('presenterSetup').style.display = 'none';
        document.getElementById('studentSetup').style.display = 'none';
        
        if (this.currentRole === 'presenter') {
            document.getElementById('shareLinkContainer').style.display = 'block';
            document.getElementById('shareLinkInput').value = `${window.location.origin}/?room=${roomId}`;
        }
    }
}

const app = new ScreenMirroringApp();

function selectRole(role) { app.selectRole(role); }

function endSession() {
    if (presenter && presenter.roomId) {
        presenter.endSession();
    }
}

function leaveSession() {
    if (student && student.roomId) {
        student.leaveSession();
    }
}

// GLOBAL BRIDGES
function toggleMute() {
    const btn = document.getElementById('muteBtn');
    app.isMuted = !app.isMuted;
    
    if (app.currentRole === 'presenter') {
        presenter.toggleMic(!app.isMuted);
    } else {
        student.toggleMic(!app.isMuted);
    }

    btn.classList.toggle('active', app.isMuted);
    btn.innerHTML = app.isMuted ? '<span class="icon">🔇</span> Unmute' : '<span class="icon">🎤</span> Mute';
}

async function toggleShare() {
    const btn = document.getElementById('shareBtn');
    
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

    btn.classList.toggle('active', app.isSharing);
    btn.innerHTML = app.isSharing ? '<span class="icon">⏹</span> Stop Sharing' : '<span class="icon">📺</span> Share Screen';
}

function toggleFullscreen() {
    const container = document.querySelector('.video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
}

function openFeedbackModal() {
    // Get current user info
    const userEmail = app.currentRole === 'presenter' ? 
        document.getElementById('presEmail')?.value : 
        (student ? document.getElementById('studentEmail')?.value : null);
    
    const userName = app.currentRole === 'presenter' ? 
        document.getElementById('presName')?.value : 
        (student ? document.getElementById('studentName')?.value : null);
    
    // Store user info for feedback submission
    window.feedbackUserInfo = {
        email: userEmail,
        name: userName
    };
    
    // Show the feedback modal
    document.getElementById('feedbackModal').style.display = 'flex';
    
    // Reset rating
    resetFeedbackRating();
}

function closeFeedbackModal() {
    document.getElementById('feedbackModal').style.display = 'none';
    resetFeedbackRating();
}

function resetFeedbackRating() {
    window.selectedRating = 0;
    document.getElementById('ratingGroup').querySelectorAll('.rating-star').forEach(star => {
        star.classList.remove('active');
    });
    document.getElementById('ratingText').textContent = 'Click on a star to rate';
    document.getElementById('submitRatingBtn').disabled = true;
    document.getElementById('feedbackMessage').innerHTML = '';
    document.getElementById('feedbackMessageInput').value = '';
}

async function submitRating() {
    if (!window.selectedRating || !window.feedbackUserInfo?.email) {
        return;
    }
    
    const submitBtn = document.getElementById('submitRatingBtn');
    const messageDiv = document.getElementById('feedbackMessage');
    const messageInput = document.getElementById('feedbackMessageInput');
    const message = messageInput.value.trim() || null;
    
    // Disable submit button
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    
    try {
        const response = await fetch('/api/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: window.feedbackUserInfo.email,
                rating: window.selectedRating,
                message: message
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            messageDiv.innerHTML = `
                <div class="success-message">
                    ✅ Thank you! Your feedback has been submitted successfully.
                </div>
            `;
            
            // Close modal after 2 seconds
            setTimeout(() => {
                closeFeedbackModal();
            }, 2000);
        } else {
            throw new Error(result.error || 'Failed to submit feedback');
        }
    } catch (error) {
        console.error('Error submitting rating:', error);
        messageDiv.innerHTML = `
            <div class="error-message">
                ❌ Failed to submit feedback: ${error.message}. Please try again.
            </div>
        `;
        
        // Re-enable submit button
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Feedback';
    }
}
