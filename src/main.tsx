import ReactDOM from 'react-dom/client'
import App from './App'
import { bootstrap } from './store/workspace'
import './styles/global.css'
import '@xterm/xterm/css/xterm.css'

// Restore the previous session (or open a fresh tab) and start autosave
// before the first render so the store always has an active workspace.
bootstrap()

// NOTE: no <React.StrictMode> — terminal/agent widgets spawn real PTYs and
// launch `claude` in mount effects, and StrictMode's double-invoke would
// double-spawn them (and collide claude --session-id with itself).
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
