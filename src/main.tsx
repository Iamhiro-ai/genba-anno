import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './pages/App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つかりません（index.html を確認してください）');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
