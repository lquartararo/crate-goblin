import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { Panel } from './Panel.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
