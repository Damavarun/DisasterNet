import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CheckCheck, ChevronRight, Clock3, Copy,
  Database, Hash, HelpCircle, LoaderCircle, LockKeyhole, Menu, Network, Radio, Search,
  Send, ShieldCheck, Siren, Users, Wifi, WifiOff, X } from 'lucide-react';
import { api, mergeMessages } from './api.js';

const shortId = id => id ? `${id.slice(0, 8)}.${id.slice(-5)}` : 'Starting.';
const time = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const date = timestamp => new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const categories = ['Medical', 'Trapped', 'Evacuation', 'Food & water', 'Other'];

function Message({ message, name }) {
  const own = message.isLocal && message.senderName === name;
  const count = message.receipts?.length ?? 0;
  const expired = message.state === 'expired' || message.expiresAt <= Date.now();
  const label = count ? `Received by ${count} node${count === 1 ? '' : 's'}`
    : expired ? 'Expired � no receipt' : message.state === 'pending' ? 'Pending � waiting for peers'
      : message.state === 'published' ? 'Published � awaiting receipt' : 'Received on this node';
  const Status = count ? CheckCheck : message.state === 'pending' ? Clock3 : Check;
  return <article className={`message ${own ? 'own' : ''} ${message.kind === 'sos' ? 'emergency-message' : ''}`}>
    <div className={`avatar ${message.kind === 'sos' ? 'alert-avatar' : ''}`} aria-hidden="true">
      {message.kind === 'sos' ? <Siren size={18} /> : message.senderName.slice(0, 2).toUpperCase()}
    </div>
    <div className="message-content">
      <div className="message-meta"><strong>{message.senderName}</strong>{own && <span className="you-label">YOU</span>}<time dateTime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time></div>
      <div className="message-bubble">
        {message.kind === 'sos' && <div className="sos-label"><Siren size={14} /> SOS REQUEST � {message.category}</div>}
        <p>{message.body}</p>
        {message.location && <p className="message-location">Location: {message.location}</p>}
      </div>
      <div className={`message-status ${count ? 'acknowledged' : ''}`} title={count ? message.receipts.map(r => shortId(r.peerId)).join(', ') : label}>
        <Status size={12} /> {label}
      </div>
    </div>
  </article>;
}

function Dialog({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className="dialog" onCancel={onClose}>
    <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
    {children}
  </dialog>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [name, setName] = useState(() => localStorage.getItem('disasternet-name') || '');
  const [editingName, setEditingName] = useState('');
  const [pin, setPin] = useState('');
  const [rooms, setRooms] = useState([]);
  const [roomId, setRoomId] = useState('general');
  const [messages, setMessages] = useState({});
  const [status, setStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [peerAddress, setPeerAddress] = useState('');
  const [sos, setSos] = useState({ category: 'Medical', body: '', location: '' });
  const [copied, setCopied] = useState(false);
  const bottom = useRef(null);
  const active = rooms.find(room => room.id === roomId);
  const all = messages[roomId] ?? [];
  const visible = all.filter(message => `${message.body} ${message.senderName} ${message.category ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const peerCount = status?.peers.filter(peer => peer.subscribed).length ?? 0;
  const pendingCount = Object.values(messages).flat().filter(m => m.isLocal && !m.receipts?.length && m.expiresAt > Date.now()).length;

  const handleError = useCallback(error => {
    setError(error.message);
    if (error.status === 401) setAuthenticated(false);
  }, []);
  const refreshSession = useCallback(async () => {
    setChecking(true);
    try { const data = await api('/session'); setAuthenticated(data.authenticated); setError(''); }
    catch (error) { setError(error.message); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void refreshSession(); }, [refreshSession]);

  useEffect(() => {
    if (!authenticated) return;
    let stopped = false;
    let socket;
    let retry;
    let attempts = 0;
    const connect = () => {
      socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`);
      socket.onopen = () => {
        if (stopped) return socket.close();
        setConnected(true); setError(''); attempts = 0;
        // Fetch missed updates after every reconnect, rather than relying only on live events.
        void Promise.all([api('/rooms'), api('/status')]).then(async ([list, nextStatus]) => {
          if (stopped) return;
          setRooms(list); setStatus(nextStatus);
          const histories = await Promise.all(list.map(async room => [room.id, await api(`/messages?roomId=${room.id}`)]));
          if (!stopped) setMessages(previous => {
            const next = { ...previous };
            for (const [id, history] of histories) next[id] = mergeMessages(next[id], history);
            return next;
          });
        }).catch(handleError);
      };
      socket.onmessage = event => {
        if (stopped) return;
        const update = JSON.parse(event.data);
        if (update.type === 'status') setStatus(update.data);
        if (update.type === 'message') setMessages(previous => ({ ...previous,
          [update.data.roomId]: mergeMessages(previous[update.data.roomId], [update.data]),
        }));
      };
      socket.onclose = event => {
        if (stopped) return;
        setConnected(false);
        if (event.code === 1008) { setAuthenticated(false); return; }
        void api('/session').then(data => { if (!stopped && !data.authenticated) setAuthenticated(false); }).catch(() => {});
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); socket?.close(); };
  }, [authenticated, handleError]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [roomId, all.length]);

  async function join(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('/session', { method: 'POST', body: JSON.stringify({ pin }) });
      localStorage.setItem('disasternet-name', name.trim());
      setName(name.trim()); setPin(''); setAuthenticated(true);
    } catch (error) { handleError(error); }
    finally { setBusy(false); }
  }
  async function send(event) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const message = await api('/messages', { method: 'POST', body: JSON.stringify({ roomId, senderName: name, body: draft }) });
      setMessages(previous => ({ ...previous, [roomId]: mergeMessages(previous[roomId], [message]) }));
      setDraft('');
    } catch (error) { handleError(error); }
    finally { setBusy(false); }
  }
  async function sendSos(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const message = await api('/messages', { method: 'POST', body: JSON.stringify({ ...sos, senderName: name, roomId: 'rescue', kind: 'sos' }) });
      setMessages(previous => ({ ...previous, rescue: mergeMessages(previous.rescue, [message]) }));
      setRoomId('rescue'); setDialog(null); setSos({ category: 'Medical', body: '', location: '' });
    } catch (error) { handleError(error); }
    finally { setBusy(false); }
  }
  async function connectPeer(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { setStatus(await api('/peers', { method: 'POST', body: JSON.stringify({ address: peerAddress.trim() }) })); setPeerAddress(''); setDialog(null); }
    catch (error) { handleError(error); }
    finally { setBusy(false); }
  }
  async function loadEarlier() {
    if (!all.length) return;
    setLoading(true);
    try {
      const history = await api(`/messages?roomId=${roomId}&before=${all[0].createdAt}`);
      setMessages(previous => ({ ...previous, [roomId]: mergeMessages(previous[roomId], history) }));
      if (!history.length) setError('You have reached the beginning of this room's saved history.');
    } catch (error) { handleError(error); }
    finally { setLoading(false); }
  }
  async function copyAddress() {
    const address = status?.addresses.find(a => !a.includes('/127.0.0.1/')) || status?.addresses[0];
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setDialog('connect'); setError('Copy the address below manually. Clipboard access may require HTTPS.'); }
  }

  if (!authenticated || !name) return <div className="welcome-page">
    <div className="welcome-card">
      <div className="brand-mark"><Radio size={28} /></div>
      <span className="eyebrow">WHEN CONNECTION MATTERS MOST</span>
      <h1>Stay close.<br /><span>Stay connected.</span></h1>
      <p className="welcome-description">DisasterNet keeps your community in touch over a local network. No internet connection needed.</p>
      <div className="welcome-facts"><span><Network size={16} /> Peer-to-peer</span><span><Database size={16} /> Locally stored</span></div>
      <form onSubmit={join} className="form-stack">
        <label>Your display name<input required maxLength={60} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Varun" /></label>
        <label>Local access PIN<input required minLength={8} type="password" autoComplete="current-password" value={pin} onChange={e => setPin(e.target.value)} placeholder="Ask the person running this node" /></label>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button className="primary-button" disabled={busy || checking || !name.trim()}>{busy || checking ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} {checking ? 'Checking local service.' : 'Join local network'}</button>
        {error && <button type="button" className="text-button" onClick={refreshSession}>Check connection again</button>}
      </form>
      <p className="welcome-footnote"><LockKeyhole size={13} /> Connect to the same Wi-Fi, hotspot, or Ethernet LAN.</p>
    </div>
    <div className="welcome-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><Radio size={72} /><div className="art-tag">A local connection. A collective lifeline.</div></div>
  </div>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <a className="brand" href="#" onClick={e => e.preventDefault()}><div className="brand-mark"><Radio size={23} /></div><div>DisasterNet<span>COMMUNITY LIFELINE</span></div></a>
      <button className="sos-button" onClick={() => { setError(''); setDialog('sos'); setMobileNav(false); }}><Siren size={20} /><span>Send SOS<small>Request urgent assistance</small></span><ChevronRight size={17} /></button>
      <div className="section-label">COMMUNICATION <span>{rooms.length.toString().padStart(2, '0')}</span></div>
      <nav aria-label="Chat rooms">{rooms.map(room => <button key={room.id} className={`room-button ${roomId === room.id ? 'active' : ''}`} onClick={() => { setRoomId(room.id); setSearch(''); setError(''); setMobileNav(false); }}><Hash size={18} /><span>{room.name}</span>{roomId === room.id && <span className="active-dot" />}</button>)}</nav>
      <div className="sidebar-note"><ShieldCheck size={22} /><h3>Built for the unexpected.</h3><p>Messages travel through connected local nodes. Keep your device powered and connected.</p><button onClick={() => setDialog('about')}>How it works <ArrowRight size={13} /></button></div>
      <div className="sidebar-bottom"><span className={`status-dot ${connected ? 'green' : ''}`} /><span>{connected ? 'Local service connected' : 'Reconnecting to local service.'}</span><small>Internet is not required</small></div>
      <button className="profile" onClick={() => { setEditingName(name); setDialog('profile'); }}><div className="profile-avatar">{name.slice(0, 2).toUpperCase()}</div><span>{name}<small>On {status?.nodeName ?? 'this node'}</small></span><ChevronRight size={16} /></button>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Toggle room navigation" onClick={() => setMobileNav(v => !v)}><Menu size={21} /></button><Network size={16} /><span>Local network</span><ChevronRight size={14} /><strong>{active?.name ?? 'Connecting'}</strong></div><div className="topbar-right"><span className="network-badge"><span className={`status-dot ${peerCount ? 'green' : ''}`} />{peerCount ? `${peerCount} peer${peerCount === 1 ? '' : 's'} connected` : 'Waiting for peers'}</span><button className="icon-button" aria-label="About DisasterNet" onClick={() => setDialog('about')}><HelpCircle size={19} /></button></div></header>
      <div className="workspace-body">
        <section className="chat-panel" aria-label="Room messages">
          <div className="room-heading"><div><span className="eyebrow">YOUR LOCAL COMMUNICATION SPACE</span><h1><Hash size={27} />{active?.name ?? 'Connecting.'}</h1><p>{active?.description ?? 'Connecting to the local Node.js service.'}</p></div><div className="room-icon"><Users size={23} /></div></div>
          <div className="chat-toolbar"><span><span className={`status-dot ${connected ? 'green' : ''}`} />{connected ? 'Live conversation' : 'Local service disconnected'}</span><label className="search"><Search size={15} /><input aria-label="Search loaded messages" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages" /></label></div>
          {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setError('')}><X size={16} /></button></div>}
          {!connected && <div className="connection-banner"><WifiOff size={16} /> Reconnecting to the local service. Your draft stays here.</div>}
          <div className="message-list" aria-live="polite" aria-relevant="additions text">
            {all.length >= 100 && <button className="load-earlier" disabled={loading} onClick={loadEarlier}>{loading ? 'Loading.' : 'Load earlier messages'}</button>}
            {visible.length === 0 ? <div className="empty-state"><div className="empty-symbol"><Radio size={35} /></div><span className="eyebrow">A CONNECTION STARTS HERE</span><h2>{search ? 'No matching messages' : 'You're in the right place.'}</h2><p>{search ? 'Try another name or phrase.' : 'Share an update, check on someone, or coordinate help. Your messages are saved on this node.'}</p>{!search && <span className="empty-hint"><span className="status-dot" />{peerCount ? 'Your local peers are ready.' : 'Messages will wait here until a peer connects.'}</span>}</div>
              : visible.map((message, index) => <div key={message.id}>{(index === 0 || date(message.createdAt) !== date(visible[index - 1].createdAt)) && <div className="date-divider"><span>{date(message.createdAt)}</span></div>}<Message message={message} name={name} /></div>)}
            <div ref={bottom} />
          </div>
          <div className="composer-wrap"><form className="composer" onSubmit={send}><label className="sr-only" htmlFor="message-input">Message to {active?.name}</label><textarea id="message-input" rows={2} maxLength={2000} value={draft} onChange={e => setDraft(e.target.value)} placeholder={`Message #${active?.name ?? roomId}.`} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (connected && !busy) void send(e); } }} /><div className="composer-actions"><span><LockKeyhole size={13} /> Stored locally � shared with room peers</span><button className="send-button" type="submit" disabled={busy || !draft.trim() || !connected} aria-label="Send message">{busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}</button></div></form><div className="composer-footnote"><span>Enter to send � Shift + Enter for a new line</span><span>{draft.length}/2000</span></div></div>
        </section>

        <aside className="details-panel" aria-label="Network details">
          <div className="details-title"><h2>Network overview</h2><Activity size={16} /></div>
          <div className="network-card"><div className="network-illustration"><div className="signal-ring" /><Radio size={30} /></div><span className="network-state">{peerCount ? 'Connected locally' : 'Ready to connect'}</span><p>{peerCount ? 'Your messages can reach subscribed peers on this network.' : 'Join the same network as another DisasterNet node to start sharing.'}</p><div className="network-metrics"><div><strong>{peerCount.toString().padStart(2, '0')}</strong><span>ROOM PEERS</span></div><div><strong>{pendingCount.toString().padStart(2, '0')}</strong><span>AWAITING RECEIPT*</span></div></div><small className="metrics-note">*From loaded message history</small></div>
          <div className="detail-row"><Wifi size={17} /><span>Transport<small>Local Wi-Fi / Ethernet</small></span><span className="mini-tag">LAN</span></div>
          <div className="detail-row"><Database size={17} /><span>Message storage<small>MySQL on this node</small></span><span className={`status-dot ${status?.database === 'connected' && connected ? 'green' : ''}`} /></div>
          <div className="detail-row"><Network size={17} /><span>Discovery<small>mDNS + manual connection</small></span></div>
          <div className="peers-heading"><h3>Connected nodes</h3><span>{status?.peers.length ?? 0}</span></div>
          <div className="peer-list">{status?.peers.length ? status.peers.map(peer => <div className="peer-item" key={peer.id}><div className="peer-avatar"><Network size={15} /></div><span title={peer.id}>{shortId(peer.id)}<small>{peer.subscribed ? 'Subscribed to this network' : 'Connected � joining topic'}</small></span><span className={`status-dot ${peer.subscribed ? 'green' : ''}`} /></div>) : <div className="no-peers">No connected peers yet.<br />Check Wi-Fi or connect by address.</div>}</div>
          <button className="outline-button" onClick={() => { setError(''); setDialog('connect'); }}><Network size={15} /> Connect a node <ArrowRight size={14} /></button>
          <div className="node-id"><span>THIS NODE'S ID</span><code title={status?.peerId}>{shortId(status?.peerId)}</code><button className="text-button" disabled={!status?.addresses.length} onClick={copyAddress}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied address' : 'Copy peer address'}</button></div>
          <div className="network-reminder"><span className="status-dot green" /><p>No internet needed.<br /><strong>A local network is required.</strong></p></div>
        </aside>
      </div>
      <footer className="app-footer"><span><Radio size={12} /> DISASTERNET</span><span>Local by design. Connected by community.</span><span>React � Node.js � MySQL</span></footer>
    </main>

    {dialog === 'sos' && <Dialog title="Request urgent assistance" onClose={() => setDialog(null)}><p className="dialog-description">Your SOS will be saved and shared in Rescue coordination. A network receipt confirms storage on another node; it does not confirm a rescue response.</p><form className="form-stack" onSubmit={sendSos}><label>Emergency category<select value={sos.category} onChange={e => setSos({ ...sos, category: e.target.value })}>{categories.map(category => <option key={category}>{category}</option>)}</select></label><label>What help do you need?<textarea required maxLength={2000} rows={4} value={sos.body} onChange={e => setSos({ ...sos, body: e.target.value })} placeholder="Describe the situation and number of people needing help." /></label><label>Location or nearby landmark <span className="optional">(optional)</span><input maxLength={160} value={sos.location} onChange={e => setSos({ ...sos, location: e.target.value })} placeholder="e.g. Community hall, north entrance" /></label>{error && <p role="alert" className="inline-error">{error}</p>}<button className="danger-button" disabled={busy || !connected || !sos.body.trim()}><Siren size={18} />{busy ? 'Saving SOS.' : 'Send SOS to rescue room'}</button></form></Dialog>}
    {dialog === 'connect' && <Dialog title="Connect a local node" onClose={() => setDialog(null)}><p className="dialog-description">mDNS finds nodes automatically when multicast is allowed. If discovery is blocked, paste the address shown by another node.</p><form className="form-stack" onSubmit={connectPeer}><label>Other node's peer address<input required value={peerAddress} onChange={e => setPeerAddress(e.target.value)} placeholder="/ip4/192.168.1.10/tcp/9000/p2p/." /></label>{error && <p role="alert" className="inline-error">{error}</p>}<button className="primary-button" disabled={busy || !connected}>{busy ? 'Connecting.' : 'Connect node'}<ArrowRight size={16} /></button></form><h3 className="address-heading">This node's addresses</h3><div className="address-list">{status?.addresses.map(address => <code key={address}>{address}</code>)}</div><p className="dialog-description">Both nodes need the same network name. Do not use a 127.0.0.1 address to connect separate devices.</p></Dialog>}
    {dialog === 'profile' && <Dialog title="Your local profile" onClose={() => setDialog(null)}><form className="form-stack" onSubmit={e => { e.preventDefault(); localStorage.setItem('disasternet-name', editingName.trim()); setName(editingName.trim()); setDialog(null); }}><label>Display name<input required minLength={1} maxLength={60} value={editingName} onChange={e => setEditingName(e.target.value)} /></label><p className="dialog-description">Display names are self-declared. They do not verify a person or rescue-team affiliation.</p><button className="primary-button" disabled={!editingName.trim()}>Save display name<Check size={16} /></button></form></Dialog>}
    {dialog === 'about' && <Dialog title="A local connection. A shared lifeline." onClose={() => setDialog(null)}><div className="about-list"><p><strong>1. Connect locally.</strong> Use the same Wi-Fi, hotspot, or Ethernet LAN. This app does not create a radio or Wi-Fi mesh.</p><p><strong>2. Share peer to peer.</strong> Node.js services discover each other through mDNS and distribute signed messages through libp2p GossipSub.</p><p><strong>3. Keep your history.</strong> Messages are saved in local MySQL. Pending messages retry while unexpired. Catch-up replays recent messages when their original node is online.</p><p><strong>4. Read status carefully.</strong> A receipt means another node stored the message. It does not mean a person read it or help has been dispatched.</p><p>Rooms and network names are not passwords. All subscribed network nodes can receive room traffic. This is a project prototype, not a replacement for emergency services.</p></div></Dialog>}
  </div>;
}
