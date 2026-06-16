import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Note: tldraw's <Tldraw> mounts an imperative editor; we deliberately avoid
// React.StrictMode here to prevent double-mounting the editor in development.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
