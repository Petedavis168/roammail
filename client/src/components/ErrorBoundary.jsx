import { Component } from 'react';
import { reportError } from '../errors.js';
import { t } from '../i18n.js';

/** If a screen crashes, show a way out instead of a blank page, and report it. */
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error, info) { reportError(`render: ${error?.message || error}`, (info?.componentStack || '').split('\n').find((l) => l.trim()) || ''); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', fontFamily: 'inherit' }}>
        <div>
          <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>{t("Something went wrong")}</h1>
          <p style={{ margin: '0 0 20px', color: 'var(--muted)' }}>{t("We've been told about it. Reloading usually fixes it.")}</p>
          <button className="btn primary" onClick={() => location.reload()}>{t("Reload")}</button>
        </div>
      </div>
    );
  }
}
