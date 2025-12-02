gsap.registerPlugin(ScrollTrigger);

const enterBtn = document.querySelector(".start__btn");
const field = document.querySelector(".depth");
const startScreen = document.querySelector(".start");
const scrollContainer = document.querySelector(".scroll-container");
const spacer = document.querySelector(".spacer");

// ML5 POSE DETECTION & VIDEO CANVAS
let detectionCanvas;
let detectionCtx;
let video;
let poses = [];
let bodyPose;
let handPose;
let hands = [];

// CONSTANTS
const VIDEO_WIDTH = 1024;
const VIDEO_HEIGHT = 768;
const PROMILLE_MAX = 1.8;
const PROMILLE_MAX_PROGRESS = 0.75;
const DISTORTION_MAX_PROMILLE = 1.3;
const DISTORTION_MAX_PROGRESS = 0.54;
const CENTER_MATCH_TOLERANCE = 10;
const EVASION_SPEED_THRESHOLD = 5;
const EVASION_AVOIDANCE_RADIUS = 150;
const EMERGENCY_TIMER_DURATION = 10000;

// Hand tracking interactive elements
let draggableCircle = {
    x: 512,
    y: 384,
    radius: 40,
    prevX: 512,
    prevY: 384
};

// Hollow circle target
let hollowTarget = {
    x: 300,
    y: 300,
    radius: 60,
    visible: true,
    exploding: false,
    explosionScale: 1,
    explosionOpacity: 1,
    explosionBlur: 0
};

// Panel 3 red emergency dot
let emergencyDot = {
    x: 700,
    y: 400,
    radius: 50,
    visible: true,
    expanding: false,
    currentRadius: 50,
    timerStarted: false,
    timerStart: 0
};

const STATE_LOADING = "loading";
const STATE_RUNNING = "running";
const STATE_ERROR = "error";
const ALL_STATES = [STATE_LOADING, STATE_RUNNING, STATE_ERROR];
let state = null;
let frameCount = 0;
let lastFPSTime = performance.now();
let $state, $error;

// Track which panel is currently visible
let isPanel2Visible = false;
let isPanel3Visible = false;

// Track if panel 2 interaction is complete
let isPanel2Complete = false;

// Delayed fingertip tracking for panel 3
let delayedFingertip = { x: 0, y: 0 };

// Track if emergency has taken over
let emergencyTakeover = false;

// State management function
const setState = (value, message = "") => {
    state = value;
    if ($state) $state.textContent = state;
    document.documentElement.classList.remove(...ALL_STATES);
    document.documentElement.classList.add(state);
    if (value === STATE_ERROR) {
        if ($error) {
            $error.textContent = message;
            $error.style.display = 'block';
        }
    } else {
        if ($error) $error.style.display = 'none';
    }

    // If state is now running and user has clicked enter, show main content
    if (value === STATE_RUNNING && hasClickedEnter) {
        showMainContent();
    }
};

// Helper: check if circle centers are at the same position (within small tolerance)
const circleCentersMatch = (c1, c2) => {
    const dx = c1.x - c2.x;
    const dy = c1.y - c2.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < CENTER_MATCH_TOLERANCE;
};

const preloadML5 = async () => {
    setState(STATE_LOADING);
    detectionCanvas = document.getElementById('canvas');
    detectionCtx = detectionCanvas.getContext('2d');

    // Load both body pose and hand pose models
    if (typeof ml5 === "undefined") {
        setState(STATE_ERROR, "ML5.js not found. Check the library.");
        return;
    }

    try {
        bodyPose = await ml5.bodyPose("BlazePose");
        console.log('ML5 bodyPose model ready');

        if (typeof ml5.handPose === "function") {
            handPose = await ml5.handPose();
            console.log('ML5 handPose model ready');
        } else {
            console.warn('handPose model not available');
        }

        setupCamera();
        setState(STATE_RUNNING);
        requestAnimationFrame(drawDetection);
    } catch (error) {
        setState(STATE_ERROR, "Could not load ML5 models: " + error.message);
    }
}

const setupCamera = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setState(STATE_ERROR, "No camera support found in this browser.");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }
        });

        video = document.createElement('video');
        video.classList.add("video");
        video.srcObject = stream;
        video.autoplay = true;

        scrollContainer.appendChild(video);
        await video.play();

        console.log('Camera ready and visible');
        detectionCanvas.width = video.width = VIDEO_WIDTH;
        detectionCanvas.height = video.height = VIDEO_HEIGHT;

        // Start body pose detection
        bodyPose.detectStart(video, (results) => {
            poses = results;
        });

        // Start hand pose detection if available
        if (handPose) {
            handPose.detectStart(video, (results) => {
                hands = results;
            });
        }
    } catch (error) {
        setState(STATE_ERROR, "Camera not found or access denied. Grant camera access and reload.");
    }
};

const drawDetection = () => {
    frameCount++;
    const currentTime = performance.now();

    // Log FPS every second
    if (currentTime - lastFPSTime >= 1000) {
        console.log(`FPS: ${frameCount}, Poses detected: ${poses.length}, Hands detected: ${hands.length}`);
        console.log(`Circles visible - Red: ${draggableCircle !== null}, Green: ${hollowTarget.visible}`);
        frameCount = 0;
        lastFPSTime = currentTime;
    }

    if (state === STATE_RUNNING && video && detectionCanvas) {
        // Clear canvas
        detectionCtx.clearRect(0, 0, detectionCanvas.width, detectionCanvas.height);

        // Update timer visibility based on whether blue circle is showing (panel 3 with hands detected)
        const timerElement = document.querySelector('.emergency-timer');
        const shouldShowFingertip = isPanel3Visible;
        const hasHandsDetected = hands.length > 0;

        if (timerElement) {
            if (shouldShowFingertip && hasHandsDetected && emergencyDot.timerStarted && !emergencyDot.expanding) {
                // Timer will be shown if finger detected (handled below in hand loop)
            } else {
                // Hide timer if blue circle shouldn't be shown
                timerElement.classList.add('hidden');
            }
        }

        // Draw mirrored video feed
        detectionCtx.save();
        detectionCtx.translate(detectionCanvas.width, 0);
        detectionCtx.scale(-1, 1);
        detectionCtx.drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);
        detectionCtx.restore();

        // Hand tracking and interaction (update positions in video coordinates)
        if (hands.length > 0) {
            hands.forEach(hand => {
                const fingertip = hand.keypoints.find(keypoint => keypoint.name === "index_finger_tip");
                if (!fingertip) return;

                // Mirror the x coordinate (in video space)
                const x = detectionCanvas.width - fingertip.x;
                const y = fingertip.y;

                // Panel 2: Drag the red circle with fingertip (in video coordinates)
                if (isPanel2Visible && draggableCircle &&
                    x > draggableCircle.x - 50 && x < draggableCircle.x + 50 &&
                    y > draggableCircle.y - 50 && y < draggableCircle.y + 50) {
                    draggableCircle.x = x;
                    draggableCircle.y = y;
                }

                // Panel 3: Touch emergency dot to make it expand
                if (isPanel3Visible && emergencyDot.visible && !emergencyDot.expanding) {
                    const fingertip = hand.keypoints.find(keypoint => keypoint.name === "index_finger_tip");
                    const timerElement = document.querySelector('.emergency-timer');
                    const timerSeconds = document.querySelector('.timer-seconds');

                    // Only show and update timer if index finger is detected
                    if (fingertip && emergencyDot.timerStarted) {
                        const elapsed = Date.now() - emergencyDot.timerStart;
                        const remaining = Math.max(0, 10 - elapsed / 1000);

                        if (timerElement && timerSeconds) {
                            timerElement.classList.remove('hidden');
                            timerSeconds.textContent = remaining.toFixed(1);
                        }
                    } else if (timerElement) {
                        // Hide timer if no finger detected
                        timerElement.classList.add('hidden');
                    }

                    // Check if 10 seconds have passed
                    if (emergencyDot.timerStarted && (Date.now() - emergencyDot.timerStart) >= EMERGENCY_TIMER_DURATION) {
                        emergencyDot.expanding = true;
                        console.log('Time is up! Emergency expanding automatically.');
                        // Hide timer when expanding
                        if (timerElement) timerElement.classList.add('hidden');
                    } else if (fingertip && emergencyDot.timerStarted && (Date.now() - emergencyDot.timerStart) < EMERGENCY_TIMER_DURATION) {
                        // Only allow collision detection AFTER timer has run out
                        // Before timer expires, do nothing even if finger is close
                        console.log('Timer still running - cannot touch yet');
                    }
                }

                // Check for collision only after timer expires
                if (isPanel3Visible && emergencyDot.visible && !emergencyDot.expanding &&
                    emergencyDot.timerStarted && (Date.now() - emergencyDot.timerStart) >= EMERGENCY_TIMER_DURATION) {
                    const fingertip = hand.keypoints.find(keypoint => keypoint.name === "index_finger_tip");
                    if (fingertip) {
                        // Use delayed position for collision detection in panel 3
                        const videoWidth = video.videoWidth || 1024;
                        const videoHeight = video.videoHeight || 768;
                        const scaleX = W / videoWidth;
                        const scaleY = H / videoHeight;

                        // Convert delayed screen position back to video coordinates
                        const delayedX = delayedFingertip.x / scaleX;
                        const delayedY = delayedFingertip.y / scaleY;

                        const dx = delayedX - emergencyDot.x;
                        const dy = delayedY - emergencyDot.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);

                        // If delayed fingertip gets close to the emergency dot
                        if (distance < emergencyDot.radius + 30) {
                            emergencyDot.expanding = true;
                            console.log('Emergency dot touched! Expanding...');
                            // Hide timer when touched
                            const timerElement = document.querySelector('.emergency-timer');
                            if (timerElement) timerElement.classList.add('hidden');
                        }
                    }
                }
            });
        }

        // Panel 2: Make green target move away when red circle gets close AND moving fast
        if (isPanel2Visible && draggableCircle && hollowTarget.visible) {
            const dx = draggableCircle.x - hollowTarget.x;
            const dy = draggableCircle.y - hollowTarget.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Calculate velocity of red circle
            const velocityX = draggableCircle.x - draggableCircle.prevX;
            const velocityY = draggableCircle.y - draggableCircle.prevY;
            const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY);

            // Only move away if red circle is moving fast enough AND close enough
            if (distance < EVASION_AVOIDANCE_RADIUS && speed > EVASION_SPEED_THRESHOLD) {
                // Calculate direction away from red circle
                const angle = Math.atan2(dy, dx);
                const moveDistance = 6; // How fast the green circle moves away

                // Move green target away from red circle
                hollowTarget.x -= Math.cos(angle) * moveDistance;
                hollowTarget.y -= Math.sin(angle) * moveDistance;

                // Keep within video bounds (with margin)
                const margin = hollowTarget.radius + 20;
                const videoWidth = video.videoWidth || VIDEO_WIDTH;
                const videoHeight = video.videoHeight || VIDEO_HEIGHT;
                hollowTarget.x = Math.max(margin, Math.min(videoWidth - margin, hollowTarget.x));
                hollowTarget.y = Math.max(margin, Math.min(videoHeight - margin, hollowTarget.y));

                // Show warning text with animation
                const warningText = document.querySelector('.rush-warning');
                if (warningText && warningText.classList.contains('hidden')) {
                    warningText.classList.remove('hidden');
                    // Hide warning after 3 seconds
                    setTimeout(() => {
                        if (warningText) warningText.classList.add('hidden');
                    }, 3000);
                }
            }

            // Update previous position for next frame (after checking)
            draggableCircle.prevX = draggableCircle.x;
            draggableCircle.prevY = draggableCircle.y;

            // Collision check: only remove if centers are at same position
            if (circleCentersMatch(draggableCircle, hollowTarget)) {
                if (!hollowTarget.exploding) {
                    hollowTarget.exploding = true;
                    console.log('Centers aligned! Starting explosion animation.');

                    // Animate explosion using GSAP
                    gsap.to(hollowTarget, {
                        explosionScale: 5,
                        explosionOpacity: 0,
                        explosionBlur: 30,
                        duration: 0.6,
                        ease: "power2.out",
                        onComplete: () => {
                            hollowTarget.visible = false;
                            draggableCircle = null;
                            isPanel2Complete = true;
                            console.log('Explosion complete! Circles removed.');

                            // Hide panel-2 after explosion
                            const panel2 = document.querySelector('.panel-2');
                            if (panel2) {
                                panel2.classList.add('visually-hidden');
                            }
                        }
                    });
                }
            }
        }

        // Panel 3: Expand emergency dot to fill screen
        if (isPanel3Visible && emergencyDot.expanding) {
            const maxRadius = Math.max(W, H) * 2; // Larger than screen diagonal
            if (emergencyDot.currentRadius < maxRadius) {
                emergencyDot.currentRadius += 50; // Expand rapidly
            } else if (!emergencyTakeover) {
                // Red circle has fully covered the screen
                emergencyTakeover = true;
                console.log('Emergency takeover - screen going black');

                // Hide all UI elements except panel-4
                setTimeout(() => {
                    document.body.style.backgroundColor = 'black';
                    if (field) field.style.display = 'none';
                    if (detectionCanvas) detectionCanvas.style.display = 'none';
                    const promille = document.querySelector('.promille');
                    if (promille) promille.style.display = 'none';

                    // Hide all panels except panel-4
                    const panel3 = document.querySelector('.panel-3');
                    if (panel3) panel3.classList.add('visually-hidden');
                    const panel1 = document.querySelector('.panel-1');
                    if (panel1) panel1.style.display = 'none';
                    const panel2 = document.querySelector('.panel-2');
                    if (panel2) panel2.style.display = 'none';
                    const panel25 = document.querySelector('.panel-2-5');
                    if (panel25) panel25.style.display = 'none';

                    // Show panel-4 immediately
                    setTimeout(() => {
                        const panel4 = document.querySelector('.panel-4');
                        if (panel4) {
                            panel4.classList.remove('visually-hidden');
                            panel4.style.opacity = '1';
                            panel4.style.visibility = 'visible';
                            // Disable scrolling completely after emergency takeover
                            document.body.style.overflow = 'hidden';
                            document.body.style.position = 'fixed';
                            document.body.style.width = '100%';
                            if (spacer) spacer.style.display = 'none';
                            if (field) field.style.display = 'none';
                            // Show only panel-4 in a fixed position
                            panel4.style.position = 'fixed';
                            panel4.style.inset = '0';
                            panel4.style.zIndex = '9999';
                            panel4.style.display = 'flex';

                            // Disable ScrollTrigger to prevent scroll-based updates
                            ScrollTrigger.getAll().forEach(trigger => trigger.disable());

                            console.log('Panel-4 is now visible', panel4);
                        }
                    }, 1000);
                }, 500); // Small delay before going black
            }
        }
    }
    requestAnimationFrame(drawDetection);
}

// SCROLLTRIGGER 3D FIELD ANIMATION
const scrollFieldCanvas = document.getElementById('field');
const scrollFieldCtx = scrollFieldCanvas.getContext('2d');
const headOffset = { x: 0, y: 0 };
let W, H;
let currentProgress = 0;

// Trail effect variables
const trailFade = 0.05;
let trailCanvas, trailCtx;

// Canvas resize handler
function resizeFieldCanvas() {
    W = scrollFieldCanvas.width = innerWidth;
    H = scrollFieldCanvas.height = innerHeight;

    // Also resize trail canvas
    if (trailCanvas) {
        trailCanvas.width = W;
        trailCanvas.height = H;
    }
}

// Initialize trail canvas
function initTrailCanvas() {
    trailCanvas = document.createElement('canvas');
    trailCanvas.width = W;
    trailCanvas.height = H;
    trailCtx = trailCanvas.getContext('2d');
}

// Build 3D circle field
const COUNT = 500;
const DEPTH = 3000;
const circles = [];
const rand = (min, max) => min + Math.random() * (max - min);

function createCircles() {
    for (let i = 0; i < COUNT; i++) {
        circles.push({
            x: rand(-W / 2, W / 2),
            y: rand(-H / 2, H / 2),
            z: rand(0, DEPTH),
            size: rand(1, 50),
            twinkleOffset: rand(0, Math.PI * 2), // Random phase offset for twinkling
            twinkleSpeed: rand(0.5, 1.5) // Random speed for each star
        });
    }
}

// Render 3D field with head tracking
let previousProgress = 0;

const renderField = (progress) => {
    // Don't render if emergency takeover is active
    if (emergencyTakeover) return;

    // Only apply trail fade if head is moving, not if scroll progress changed
    const progressChanged = Math.abs(progress - previousProgress) > 0.001;

    // Flickering effect for panel-3
    let shouldFlicker = false;
    if (isPanel3Visible) {
        // Slower, less frequent flicker (about 10% of the time)
        shouldFlicker = Math.random() < 0.1;
    }

    if (!progressChanged) {
        // No scroll change, apply trail fade for head movement
        if (shouldFlicker) {
            // Red background during flicker
            trailCtx.fillStyle = `rgba(139, 0, 0, ${trailFade})`;
        } else {
            trailCtx.fillStyle = `rgba(0, 0, 0, ${trailFade})`;
        }
        trailCtx.fillRect(0, 0, trailCanvas.width, trailCanvas.height);
    } else {
        // Scroll changed, clear trail completely for sharp scroll movement
        trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
        previousProgress = progress;
    }

    // Update head offset based on nose position from ML5
    if (poses.length > 0 && poses[0].keypoints) {
        const nose = poses[0].keypoints.find(k => k.name === "nose");
        if (nose && nose.confidence > 0.3) {
            const noseX = nose.x;
            const noseY = nose.y;

            // Calculate target offset (normalized to canvas size)
            const videoWidth = video ? video.videoWidth : 1024;
            const videoHeight = video ? video.videoHeight : 768;
            const targetX = ((noseX - videoWidth / 2) / videoWidth) * 200;
            const targetY = ((noseY - videoHeight / 2) / videoHeight) * 200;

            // Smoothly animate to target
            gsap.to(headOffset, {
                x: targetX,
                y: targetY,
                duration: 0.5,
                ease: "power2.out"
            });
        }
    }

    // Draw circles on trail canvas
    trailCtx.save();
    trailCtx.translate(trailCanvas.width / 2, trailCanvas.height / 2);

    const time = Date.now() * 0.001; // Time in seconds for smooth animation

    circles.forEach(circle => {
        // move through z based on scroll progress
        let z = (circle.z - progress * DEPTH);
        if (z < 0) z += DEPTH;

        // Scale head offset by progress (0 to 3x multiplier as progress goes 0 to 1)
        const headInfluence = 1 + (progress * 2);
        const scaledOffsetX = headOffset.x * headInfluence;
        const scaledOffsetY = headOffset.y * headInfluence;

        const perspective = 10 / z;
        const x2d = (circle.x + scaledOffsetX) * perspective;
        const y2d = (circle.y + scaledOffsetY) * perspective;
        const baseAlpha = 1 - z / DEPTH;

        // Add twinkling effect - slow sine wave for each star with larger range
        const twinkle = Math.sin(time * circle.twinkleSpeed + circle.twinkleOffset) * 0.6 + 0.4; // Oscillates between 0 and 1.0
        const alpha = baseAlpha * twinkle;

        // Also vary size slightly for twinkle effect
        const sizeTwinkle = Math.sin(time * circle.twinkleSpeed * 0.8 + circle.twinkleOffset) * 0.3 + 1.0; // 0.7 to 1.3
        const r = circle.size * perspective * sizeTwinkle;

        trailCtx.beginPath();

        // Flicker circles to black during panel-3
        if (shouldFlicker) {
            trailCtx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        } else {
            trailCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        }

        trailCtx.arc(x2d, y2d, r, 0, Math.PI * 2);
        trailCtx.fill();
    });

    trailCtx.restore();

    // Draw the trail canvas onto the main canvas with progressive blur and rotation
    scrollFieldCtx.clearRect(0, 0, W, H);

    // Apply extreme distortion transforms that increase with progress
    scrollFieldCtx.save();
    scrollFieldCtx.translate(W / 2, H / 2);

    // Rotation effect - starts at 0.3 progress and becomes extreme, maxed out at 1.3 promille
    if (progress >= 0.3) {
        const rotationProgress = Math.min((progress - 0.3) / (DISTORTION_MAX_PROGRESS - 0.3), 1);
        const rotationIntensity = Math.pow(rotationProgress, 1.5);
        const maxRotation = 2.5;
        const rotationAngle = (headOffset.x / 200) * maxRotation * rotationIntensity;
        scrollFieldCtx.rotate(rotationAngle);
    }

    // Scale distortion - becomes extreme at high progress, maxed out at 1.3 promille
    if (progress >= 0.4) {
        const scaleProgress = Math.min((progress - 0.4) / (DISTORTION_MAX_PROGRESS - 0.4), 1);
        const scaleIntensity = Math.pow(scaleProgress, 2);
        const scaleX = 1 + (Math.sin(Date.now() * 0.001) * 0.3 * scaleIntensity);
        const scaleY = 1 + (Math.cos(Date.now() * 0.001) * 0.3 * scaleIntensity);
        scrollFieldCtx.scale(scaleX, scaleY);
    }

    // Skew distortion - creates warped perspective at high progress, maxed out at 1.3 promille
    if (progress >= 0.5) {
        const skewProgress = Math.min((progress - 0.5) / (DISTORTION_MAX_PROGRESS - 0.5), 1);
        const skewIntensity = Math.pow(skewProgress, 2);
        const skewX = Math.sin(Date.now() * 0.002) * 0.5 * skewIntensity;
        const skewY = Math.cos(Date.now() * 0.002) * 0.5 * skewIntensity;
        scrollFieldCtx.transform(1, skewY, skewX, 1, 0, 0);
    }

    scrollFieldCtx.translate(-W / 2, -H / 2);

    // Apply blur filter based on scroll progress (0 to 10px blur)
    const blurAmount = progress * 10;
    scrollFieldCtx.filter = `blur(${blurAmount}px)`;
    scrollFieldCtx.drawImage(trailCanvas, 0, 0);
    scrollFieldCtx.filter = 'none'; // Reset filter

    scrollFieldCtx.restore();

    // Add red background flicker for panel-3 AFTER distortion (so it's not distorted)
    if (shouldFlicker) {
        scrollFieldCtx.fillStyle = 'rgba(139, 0, 0, 1)';
        scrollFieldCtx.fillRect(0, 0, W, H);
    }
}

// Continuous animation loop for field
function animateField() {
    renderField(currentProgress);

    // Draw hand interaction elements on top of the field
    drawHandInteraction();

    requestAnimationFrame(animateField);
}

// Draw hand interaction on the full-screen field canvas
function drawHandInteraction() {
    // Don't draw if emergency takeover is active
    if (emergencyTakeover) return;
    if (!video || !scrollFieldCanvas) return;

    const videoWidth = video.videoWidth || 1024;
    const videoHeight = video.videoHeight || 768;

    // Scale factors to map from video coordinates to screen coordinates
    const scaleX = W / videoWidth;
    const scaleY = H / videoHeight;

    // PANEL 2: Draw green target and red draggable circle
    if (isPanel2Visible) {
        const blurAmount = currentProgress * 10;
        scrollFieldCtx.filter = `blur(${blurAmount}px)`;

        // Calculate distortion (50% of the main effect)
        const time = Date.now() * 0.001;
        const distortionIntensity = Math.min(currentProgress * 0.5, 0.5); // Max 50% distortion
        const offsetX = Math.sin(time * 2) * 50 * distortionIntensity;
        const offsetY = Math.cos(time * 2) * 50 * distortionIntensity;
        const scaleVariation = 1 + (Math.sin(time * 1.5) * 0.3 * distortionIntensity);

        // Draw hollow green target circle (scaled to screen)
        if (hollowTarget.visible) {
            const targetX = hollowTarget.x * scaleX + offsetX;
            const targetY = hollowTarget.y * scaleY + offsetY;
            const baseRadius = hollowTarget.radius * Math.min(scaleX, scaleY) * scaleVariation;

            // Apply explosion animation
            const targetRadius = baseRadius * hollowTarget.explosionScale;
            const opacity = hollowTarget.explosionOpacity;
            const extraBlur = hollowTarget.explosionBlur;

            scrollFieldCtx.filter = `blur(${blurAmount + extraBlur}px)`;
            scrollFieldCtx.beginPath();
            scrollFieldCtx.arc(targetX, targetY, targetRadius, 0, 2 * Math.PI);
            scrollFieldCtx.strokeStyle = `rgba(0, 255, 0, ${opacity})`;
            scrollFieldCtx.lineWidth = 8;
            scrollFieldCtx.stroke();
        }

        // Draw red draggable circle (scaled to screen)
        if (draggableCircle) {
            const circleX = draggableCircle.x * scaleX + offsetX;
            const circleY = draggableCircle.y * scaleY + offsetY;
            const circleRadius = draggableCircle.radius * Math.min(scaleX, scaleY) * scaleVariation;

            scrollFieldCtx.beginPath();
            scrollFieldCtx.arc(circleX, circleY, circleRadius, 0, 2 * Math.PI);
            scrollFieldCtx.fillStyle = 'rgba(255,0,0,0.7)';
            scrollFieldCtx.fill();
            scrollFieldCtx.strokeStyle = 'red';
            scrollFieldCtx.lineWidth = 3;
            scrollFieldCtx.stroke();
        }

        scrollFieldCtx.filter = 'none';
    }

    // PANEL 3: Draw emergency red dot
    if (isPanel3Visible && emergencyDot.visible) {
        const blurAmount = currentProgress * 10;
        scrollFieldCtx.filter = `blur(${blurAmount}px)`;

        // Calculate distortion for emergency dot (50% of main effect)
        const time = Date.now() * 0.001;
        const distortionIntensity = Math.min(currentProgress * 0.5, 0.5);
        const offsetX = Math.sin(time * 2) * 50 * distortionIntensity;
        const offsetY = Math.cos(time * 2) * 50 * distortionIntensity;
        const scaleVariation = 1 + (Math.sin(time * 1.5) * 0.3 * distortionIntensity);

        const dotX = emergencyDot.x * scaleX + offsetX;
        const dotY = emergencyDot.y * scaleY + offsetY;
        const dotRadius = emergencyDot.currentRadius * Math.min(scaleX, scaleY) * scaleVariation;

        scrollFieldCtx.beginPath();
        scrollFieldCtx.arc(dotX, dotY, dotRadius, 0, 2 * Math.PI);
        scrollFieldCtx.fillStyle = 'rgba(255,0,0,0.95)';
        scrollFieldCtx.fill();

        // Only show stroke and pulse if not expanding
        if (!emergencyDot.expanding) {
            scrollFieldCtx.strokeStyle = 'red';
            scrollFieldCtx.lineWidth = 4;
            scrollFieldCtx.stroke();

            // Add pulsing effect for urgency
            const pulse = Math.sin(Date.now() / 200) * 0.2 + 1;
            scrollFieldCtx.beginPath();
            scrollFieldCtx.arc(dotX, dotY, dotRadius * pulse, 0, 2 * Math.PI);
            scrollFieldCtx.strokeStyle = 'rgba(255,0,0,0.4)';
            scrollFieldCtx.lineWidth = 2;
            scrollFieldCtx.stroke();
        }

        scrollFieldCtx.filter = 'none';
    }

    // Draw hand tracking fingertip (for both panels)
    // Show in panel 2 only before completion, or show in panel 3
    const shouldShowFingertip = (isPanel2Visible && !isPanel2Complete) || isPanel3Visible;
    if (shouldShowFingertip && hands.length > 0) {
        hands.forEach(hand => {
            const fingertip = hand.keypoints.find(keypoint => keypoint.name === "index_finger_tip");
            if (!fingertip) return;

            // Mirror the x coordinate and scale to screen
            const targetX = (videoWidth - fingertip.x) * scaleX;
            const targetY = fingertip.y * scaleY;

            let displayX, displayY;

            if (isPanel3Visible) {
                // Panel 3: Apply heavy delay/lag to fingertip movement
                gsap.to(delayedFingertip, {
                    x: targetX,
                    y: targetY,
                    duration: 1.5, // Very slow response (1.5 seconds delay)
                    ease: "power1.inOut"
                });
                displayX = delayedFingertip.x;
                displayY = delayedFingertip.y;
            } else {
                // Panel 2: Apply moderate delay for initial difficulty
                gsap.to(delayedFingertip, {
                    x: targetX,
                    y: targetY,
                    duration: 0.4, // Moderate delay (0.4 seconds)
                    ease: "power1.out"
                });
                displayX = delayedFingertip.x;
                displayY = delayedFingertip.y;
            }

            // Draw blue dot for fingertip with blur
            const blurAmount = currentProgress * 10;
            scrollFieldCtx.filter = `blur(${blurAmount}px)`;
            scrollFieldCtx.beginPath();
            scrollFieldCtx.arc(displayX, displayY, 12 * Math.min(scaleX, scaleY), 0, 2 * Math.PI);
            scrollFieldCtx.fillStyle = 'cyan';
            scrollFieldCtx.fill();
            scrollFieldCtx.strokeStyle = 'blue';
            scrollFieldCtx.lineWidth = 2;
            scrollFieldCtx.stroke();
            scrollFieldCtx.filter = 'none';
        });
    }
}

// Setup ScrollTrigger for field animation
function setupScrollTriggers() {
    // Helper function to calculate promille from progress
    const calculatePromille = (progress) => {
        if (progress <= PROMILLE_MAX_PROGRESS) {
            return (progress / PROMILLE_MAX_PROGRESS) * PROMILLE_MAX;
        }
        return PROMILLE_MAX;
    };

    // Main scroll progress tracker
    gsap.to({}, {
        scrollTrigger: {
            trigger: ".spacer",
            start: "top top",
            end: "bottom bottom",
            scrub: true,
            onUpdate: self => {
                currentProgress = self.progress;

                // Update promille counter
                const promilleValue = calculatePromille(self.progress);
                const promilleCounter = document.querySelector('.promille__counter');
                if (promilleCounter) {
                    promilleCounter.textContent = `${promilleValue.toFixed(1)}‰`;
                }

                // Update units of alcohol (0.2 promille = 1 unit)
                const unitsOfAlcohol = Math.floor(promilleValue / 0.2);
                const unitsCounter = document.querySelector('.promille__unit__counter');
                if (unitsCounter) {
                    unitsCounter.textContent = unitsOfAlcohol;
                }
            }
        }
    });

    // Show/hide panels based on scroll progress and promille values
    const panels = document.querySelectorAll('.panel');
    panels.forEach((panel, index) => {
        ScrollTrigger.create({
            trigger: ".spacer",
            start: "top top",
            end: "bottom bottom",
            onUpdate: (self) => {
                // Calculate current promille value
                const promilleValue = calculatePromille(self.progress);

                let shouldShowPanel = false;

                // Panel-1: Show only after 0.2 promille (around 11% progress)
                if (panel.classList.contains('panel-1')) {
                    shouldShowPanel = promilleValue >= 0.2 && promilleValue < 0.8;
                }
                // Panel-2: Show from 0.8 to 1.5 promille (unless completed)
                else if (panel.classList.contains('panel-2')) {
                    shouldShowPanel = !isPanel2Complete && promilleValue >= 0.8 && promilleValue < 1.5;
                }
                // Panel-2.5: Show at 1.2 promille
                else if (panel.classList.contains('panel-2-5')) {
                    shouldShowPanel = promilleValue >= 1.2 && promilleValue < 1.5;
                }
                // Panel-3: Show from 1.5 promille onwards
                else if (panel.classList.contains('panel-3')) {
                    shouldShowPanel = promilleValue >= 1.5 && promilleValue < 1.8;
                }
                // Panel-4: Show at 1.8 promille (after emergency)
                else if (panel.classList.contains('panel-4')) {
                    shouldShowPanel = promilleValue >= 1.8;
                }

                if (shouldShowPanel) {
                    panel.classList.remove('visually-hidden');

                    // Track if panel-2 is visible
                    if (panel.classList.contains('panel-2')) {
                        isPanel2Visible = true;
                    }

                    // Track if panel-3 is visible
                    if (panel.classList.contains('panel-3')) {
                        isPanel3Visible = true;
                        // Reset emergency dot when entering panel-3
                        emergencyDot.visible = true;
                        emergencyDot.expanding = false;
                        emergencyDot.currentRadius = 50;
                        emergencyTakeover = false;

                        // Start 10-second timer
                        if (!emergencyDot.timerStarted) {
                            emergencyDot.timerStarted = true;
                            emergencyDot.timerStart = Date.now();
                            console.log('Emergency timer started - 10 seconds to respond');
                        }

                        // Make sure elements are visible again if re-entering panel-3
                        document.body.style.backgroundColor = '';
                        if (scrollContainer) scrollContainer.style.display = '';
                        if (field) field.style.display = '';
                        if (detectionCanvas) detectionCanvas.style.display = '';
                        const promille = document.querySelector('.promille');
                        if (promille) promille.style.display = '';
                    }
                } else {
                    panel.classList.add('visually-hidden');

                    // Track if panel-2 is hidden
                    if (panel.classList.contains('panel-2')) {
                        isPanel2Visible = false;
                    }

                    // Track if panel-3 is hidden
                    if (panel.classList.contains('panel-3')) {
                        isPanel3Visible = false;
                        // Reset timer when leaving panel-3
                        emergencyDot.timerStarted = false;
                    }
                }
            }
        });
    });
}

// ENTER BUTTON HANDLER
let hasClickedEnter = false;
const loadingScreen = document.querySelector('.loading-screen');

enterBtn.addEventListener("click", () => {
    hasClickedEnter = true;
    startScreen.classList.add("hidden");

    // If still loading, show loading screen
    if (state === STATE_LOADING) {
        if (loadingScreen) loadingScreen.classList.remove('hidden');
    } else if (state === STATE_RUNNING) {
        // Already running, show everything
        showMainContent();
    }
});

function showMainContent() {
    if (loadingScreen) loadingScreen.classList.add('hidden');
    field.classList.remove("visually-hidden");
    scrollContainer.classList.remove("hidden");

    // Show the canvas and spacer
    const canvas = document.getElementById('field');
    if (canvas) canvas.classList.add('visible');
    if (spacer) spacer.classList.add('visible');

    // Refresh ScrollTrigger after elements become visible
    setTimeout(() => {
        ScrollTrigger.refresh();
    }, 100);
}

const init = () => {
    // Get state elements
    $state = document.querySelector('#state');
    $error = document.querySelector('#error');

    // Setup ScrollTrigger field
    resizeFieldCanvas();
    initTrailCanvas();
    addEventListener('resize', resizeFieldCanvas);
    createCircles();
    setupScrollTriggers();
    animateField();

    // Setup ML5 detection
    preloadML5();
};

// Start everything
init();