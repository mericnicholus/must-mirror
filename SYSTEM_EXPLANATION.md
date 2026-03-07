# Offline Screen Sharing System - Technical Documentation

## 1. Overview
This system is designed for **totally offline** lecture environments (no internet required). It allows one or more presenters to share their screens with students in real-time using a local Wi-Fi or Bluetooth-enabled network.

## 2. Technology Stack
*   **Backend:** Node.js with Express (serves files and handles signaling).
*   **Real-time Signaling:** Socket.io (coordinates connections between peers).
*   **Media Streaming:** WebRTC (Real-Time Communication).
*   **Scalability:** SFU (Selective Forwarding Unit) logic in `sfu-server.js` helps manage high student loads.
*   **Discovery:** Simulated Bluetooth Beaconing via Socket.io broadcasts.

## 3. How It Works (Offline Strategy)
### A. No Internet / No Power
*   The system can run on a **battery-powered laptop** acting as a server and Wi-Fi hotspot.
*   Students connect to the laptop's Wi-Fi. Since everything is local, no data plan or internet connection is needed.
*   **Security:** Because the network is local (LAN), data never leaves the room, making it highly secure against external hacking.

### B. Bluetooth Discovery
*   The system uses "Discovery Broadcasts". When a presenter creates a room, the server "shouts" (broadcasts) the room details to all connected students.
*   In a real-world implementation, this can be linked to the **Web Bluetooth API** to advertise the server's IP address.

## 4. Room ID Generation
The Room ID is generated dynamically in `presenter.js` using a professional naming convention:
**Formula:** `[DEPT]-[ROOM]-[NAME]`
*   **DEPT:** First 3 letters of the Department (e.g., Computer Science -> `CS`).
*   **ROOM:** The physical room name without spaces (e.g., Lab 202 -> `LAB202`).
*   **NAME:** The last name of the presenter.

**Example:** `CS-LAB202-DOE`
This makes the room easily identifiable for students in a busy building with multiple lectures.

## 5. Screen Sharing Technicals
1.  **Capture:** The browser uses `getDisplayMedia()` to record the screen.
2.  **Handshake:** 
    *   Presenter sends an **Offer** (connection details).
    *   Student sends an **Answer**.
    *   They exchange **ICE Candidates** (local network addresses).
3.  **Transmission:** Once connected, video data travels directly (Peer-to-Peer) over the local Wi-Fi.

## 6. Security
*   **Email Validation:** Only students with official `@std.must.ac.ug` emails can join.
*   **Local-Only:** The server only listens on the local network (no cloud involved).

## 7. How to Use
1.  Run `npm start` on the presenter's laptop.
2.  Note the laptop's IP address (e.g., `192.168.1.10`).
3.  Students open `http://192.168.1.10:3000` in their browsers.
4.  Presenter creates a room; students will see it appear in their "Nearby Rooms" list automatically.
