import { useEffect, useMemo, useState } from 'react';

const tokenKey = 'glenda_admin_token';

async function apiRequest(path, options = {}, token) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onLogin(data.token, data.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell login-shell">
      <div className="card card--hero">
        <p className="eyebrow">Glenda Residences</p>
        <h1 className="hero-title">Admin Console</h1>
        <p className="muted">Secure access for billing, tenants, and reminders.</p>
      </div>

      <form className="card form-card" onSubmit={submit}>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@glenda.local" required />

        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="********" required />

        {error ? <p className="error-text">{error}</p> : null}

        <button className="cta-btn" disabled={loading} type="submit">
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ token, onLogout, email }) {
  const [dashboard, setDashboard] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [activeFilter, setActiveFilter] = useState('all');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [registerForm, setRegisterForm] = useState({
    tenant_name: '',
    room_number: '',
    contact_number: '',
    move_in_date: 'today',
    room_rate: '',
    electricity_rate: '',
    electricity_reading: '',
    water_rate: 'fixed:100',
    water_reading: '',
  });

  const [readingForm, setReadingForm] = useState({
    room_number: '',
    electricity_reading: '',
    water_reading: '',
  });

  const fetchData = async () => {
    setError('');
    try {
      const [dashboardData, roomData] = await Promise.all([
        apiRequest('/api/dashboard', {}, token),
        apiRequest('/api/rooms', {}, token),
      ]);
      setDashboard(dashboardData);
      setRooms(roomData);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRooms = useMemo(() => {
    if (activeFilter === 'all') return rooms;
    if (activeFilter === 'unpaid') return rooms.filter((room) => (room.latest_bill_status || 'unpaid') === 'unpaid');
    if (activeFilter === 'paid') return rooms.filter((room) => room.latest_bill_status === 'paid');
    return rooms;
  }, [rooms, activeFilter]);

  const unpaidPercent = dashboard?.rooms ? Math.round(((dashboard.unpaidCount || 0) / dashboard.rooms) * 100) : 0;

  const runAction = async (action) => {
    setMessage('');
    setError('');
    try {
      await action();
      setMessage('Action completed successfully.');
      await fetchData();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitRegister = async (event) => {
    event.preventDefault();
    await runAction(() =>
      apiRequest('/api/tenants/register', {
        method: 'POST',
        body: JSON.stringify(registerForm),
      }, token)
    );
  };

  const submitReading = async (event) => {
    event.preventDefault();
    await runAction(() =>
      apiRequest('/api/readings/input', {
        method: 'POST',
        body: JSON.stringify(readingForm),
      }, token)
    );
  };

  const markPaid = async (billId) => runAction(() => apiRequest(`/api/bills/${billId}/mark-paid`, { method: 'POST', body: JSON.stringify({ notes: 'Paid via admin webapp' }) }, token));
  const sendReminder = async (billId) => runAction(() => apiRequest(`/api/bills/${billId}/send-reminder`, { method: 'POST' }, token));
  const sendAllReminders = async () => runAction(() => apiRequest('/api/bills/send-reminder-all', { method: 'POST' }, token));

  return (
    <div className="app-shell">
      <header className="header card">
        <div>
          <p className="muted">Good evening</p>
          <h2>{email}</h2>
        </div>
        <button className="ghost-btn" onClick={onLogout}>Logout</button>
      </header>

      <section className="card card--hero">
        <p className="eyebrow">Outstanding Balance</p>
        <h1 className="hero-title">PHP {Number(dashboard?.unpaidAmount || 0).toFixed(2)}</h1>
        <p className="muted">{dashboard?.unpaidCount || 0} unpaid bills across {dashboard?.rooms || 0} rooms</p>
      </section>

      <section className="quick-stats">
        <div className="pill">Rooms {dashboard?.rooms || 0}</div>
        <div className="pill">Unpaid {dashboard?.unpaidCount || 0}</div>
        <div className="pill">30D PHP {Number(dashboard?.billedLast30Days || 0).toFixed(0)}</div>
      </section>

      <section className="card ring-card">
        <div className="ring" style={{ '--ring-percent': `${Math.min(Math.max(unpaidPercent, 0), 100)}%` }}>
          <span>{unpaidPercent}%</span>
        </div>
        <div>
          <h3>Delinquency Ratio</h3>
          <p className="muted">Rooms with unpaid latest bills.</p>
        </div>
      </section>

      <section className="filter-pills">
        <button className={`pill ${activeFilter === 'all' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('all')}>All</button>
        <button className={`pill ${activeFilter === 'unpaid' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('unpaid')}>Unpaid</button>
        <button className={`pill ${activeFilter === 'paid' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('paid')}>Paid</button>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>Room Ledger</h3>
          <button className="ghost-btn" onClick={sendAllReminders}>Send All Reminders</button>
        </div>
        {filteredRooms.map((room) => (
          <div className="transaction-item" key={room.id}>
            <div className="transaction-icon">{room.room_number}</div>
            <div className="grow">
              <p>{room.tenant_name || 'VACANT'}</p>
              <p className="muted">{room.latest_bill_period_start ? `${room.latest_bill_period_start} to ${room.latest_bill_period_end}` : 'No bill yet'}</p>
            </div>
            <div className="amount-col">
              <p className={room.latest_bill_status === 'paid' ? 'transaction-amount--positive' : 'transaction-amount--negative'}>
                PHP {Number(room.latest_bill_total || 0).toFixed(2)}
              </p>
              <div className="row-actions">
                {room.latest_bill_id ? <button className="mini-btn" onClick={() => sendReminder(room.latest_bill_id)}>SMS</button> : null}
                {room.latest_bill_id && room.latest_bill_status !== 'paid' ? <button className="mini-btn" onClick={() => markPaid(room.latest_bill_id)}>Paid</button> : null}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="card form-card">
        <h3>Register Tenant</h3>
        <form onSubmit={submitRegister}>
          <input placeholder="Tenant Name" value={registerForm.tenant_name} onChange={(e) => setRegisterForm((p) => ({ ...p, tenant_name: e.target.value }))} required />
          <input placeholder="Room Number" value={registerForm.room_number} onChange={(e) => setRegisterForm((p) => ({ ...p, room_number: e.target.value }))} required />
          <input placeholder="Contact Number" value={registerForm.contact_number} onChange={(e) => setRegisterForm((p) => ({ ...p, contact_number: e.target.value }))} required />
          <input placeholder="Move in Date" value={registerForm.move_in_date} onChange={(e) => setRegisterForm((p) => ({ ...p, move_in_date: e.target.value }))} required />
          <input placeholder="Room Rate" value={registerForm.room_rate} onChange={(e) => setRegisterForm((p) => ({ ...p, room_rate: e.target.value }))} required />
          <input placeholder="Electricity Rate" value={registerForm.electricity_rate} onChange={(e) => setRegisterForm((p) => ({ ...p, electricity_rate: e.target.value }))} required />
          <input placeholder="Current Electricity Reading" value={registerForm.electricity_reading} onChange={(e) => setRegisterForm((p) => ({ ...p, electricity_reading: e.target.value }))} required />
          <input placeholder="Water Rate (fixed:100 or per:15)" value={registerForm.water_rate} onChange={(e) => setRegisterForm((p) => ({ ...p, water_rate: e.target.value }))} required />
          <input placeholder="Current Water Reading" value={registerForm.water_reading} onChange={(e) => setRegisterForm((p) => ({ ...p, water_reading: e.target.value }))} required />
          <button className="cta-btn" type="submit">Register</button>
        </form>
      </section>

      <section className="card form-card">
        <h3>Input Reading</h3>
        <form onSubmit={submitReading}>
          <input placeholder="Room Number" value={readingForm.room_number} onChange={(e) => setReadingForm((p) => ({ ...p, room_number: e.target.value }))} required />
          <input placeholder="Current Electricity Reading" value={readingForm.electricity_reading} onChange={(e) => setReadingForm((p) => ({ ...p, electricity_reading: e.target.value }))} required />
          <input placeholder="Current Water Reading" value={readingForm.water_reading} onChange={(e) => setReadingForm((p) => ({ ...p, water_reading: e.target.value }))} required />
          <button className="cta-btn" type="submit">Generate Bill</button>
        </form>
      </section>

      {message ? <p className="ok-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <nav className="bottom-nav">
        <button className="nav-item nav-item--active">Home</button>
        <button className="nav-item">Bills</button>
        <button className="nav-btn--add">+</button>
        <button className="nav-item">Stats</button>
        <button className="nav-item">Admin</button>
      </nav>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem(tokenKey) || '');
  const [email, setEmail] = useState('');

  const handleLogin = (newToken, userEmail) => {
    localStorage.setItem(tokenKey, newToken);
    setToken(newToken);
    setEmail(userEmail || 'admin');
  };

  const handleLogout = () => {
    localStorage.removeItem(tokenKey);
    setToken('');
    setEmail('');
  };

  if (!token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return <Dashboard token={token} onLogout={handleLogout} email={email || 'admin'} />;
}
