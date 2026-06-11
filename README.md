# FIT 5120 - Monash Master Capstone Project
# 🚗 DriveBuddy — AI-Powered Driver Safety & Fatigue Detection Web App

**DriveBuddy** is an intelligent web application that helps drivers stay alert and safe on the road.  
It combines real-time monitoring, route weather analysis, and AI-powered voice interaction to promote safe driving habits.

---

## 🌐 Live Demo

- **Frontend:** [https://drivebuddy-iota.vercel.app](https://drivebuddy-iota.vercel.app)  
- **Backend (API):** [https://drivebuddy.onrender.com](https://drivebuddy.onrender.com)

---

## 🧩 Features

- 👁️ **Eye Tracking:** Detects driver drowsiness (e.g., eyes closed ≥ 2 seconds triggers alert).  
- 🗣️ **AI Voice Chat:** Uses LangChain-based conversational agent for real-time guidance.  
- 🗺️ **Live GPS & Route Tracking:** Integrates with Google Maps APIs for navigation, ETA, and re-routing.  
- 🌦️ **Weather Intelligence:** Fetches current and predicted weather along the route and at destination ETA.  
- 🧮 **Trip Analytics Dashboard:** Displays trip summaries, driver performance, and educational insights.  
- 🔒 **Privacy-First Design:** Only anonymized trip statistics are stored; users can delete data at trip end.


---

## ⚙️ Requirements

Make sure you have the following installed before running the app locally:

| Tool | Version (Recommended) | Description |
|------|------------------------|-------------|
| [Node.js](https://nodejs.org/) | ≥ 18.x | JavaScript runtime |
| [npm](https://www.npmjs.com/) | ≥ 9.x | Node package manager |
| [Vite](https://vitejs.dev/) | latest | Frontend build tool |
| [React](https://react.dev/) | ≥ 18.x | UI framework |

---

## 🧭 How to Run Locally

### 🖥️ Frontend Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/<your-username>/DriveBuddy.git
   cd DriveBuddy
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Start the local development server:
   ```bash
   npm run dev
   ```

5. Open your browser and visit:  
   👉 `http://localhost:5173`

---

### ⚙️ Backend Setup (Localhost Mode)

1. Navigate to the backend agent directory:
   ```bash
   cd Backend/agent
   ```

2. Install backend dependencies:
   ```bash
   npm install
   ```

3. Run the backend server:
   ```bash
   node index.js
   ```

4. The backend will run by default at:  
   👉 `http://localhost:3000`

---

### 🌍 Remote Backend (Hosted API)

If you prefer not to run the backend locally, update your frontend configuration to use the hosted API:

```
https://drivebuddy.onrender.com
```

---

## 🧠 Tech Stack

- **Frontend:** React, Vite, JavaScript, CSS  
- **Backend:** Node.js, Express.js, LangChain  
- **Database:** AWS RDS (MySQL)  
- **APIs:** Google Maps, OpenWeather  
- **Cloud:** Hosted on Render (Backend) and Vercel (Frontend)

---

## 📊 Educational Dashboard

The dashboard visualizes real-world Malaysian accident statistics using `react-d3-wordcloud` and interactive charts to help users understand key accident causes.

---

## 🔐 Privacy & Data Handling

DriveBuddy is built with privacy-by-design principles:
- No user-identifiable data is stored.
- Trip data can be deleted anytime.
- Anonymized statistics are retained for insights.


