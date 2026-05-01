import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initWebVitals } from "./lib/webVitals";

createRoot(document.getElementById("root")!).render(<App />);

// Initialize Web Vitals performance monitoring
initWebVitals();
