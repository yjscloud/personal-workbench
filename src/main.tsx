import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, initialTheme } from './lib/theme';

/* 首帧之前先落主题，避免深/浅色闪变 */
const boot = initialTheme();
applyTheme(boot.mode, boot.accent);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
