import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyTheme, cachedTheme } from './theme';

applyTheme(cachedTheme());

createRoot(document.getElementById('root')!).render(<App />);
