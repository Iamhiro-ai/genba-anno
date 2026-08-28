import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// スタイルは「トークン → グローバル → 各画面」の順に読み込む。
// App より先に global.css を評価しておかないと、同一詳細度の指定
// （global.css の ul[class] { list-style: none } 等）が後勝ちで画面側を上書きしてしまう。
import './styles/global.css';
import { App } from './pages/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つかりません（index.html を確認してください）');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
