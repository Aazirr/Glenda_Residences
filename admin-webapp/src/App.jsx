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
  const [activeTab, setActiveTab] = useState('home');
  const [dashboard, setDashboard] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [activeFilter, setActiveFilter] = useState('all');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [tenantDrafts, setTenantDrafts] = useState({});
  const [billEditDrafts, setBillEditDrafts] = useState({});

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

      setTenantDrafts((previous) => {
        const next = { ...previous };
        for (const room of roomData) {
          if (!next[room.id]) {
            next[room.id] = {
              tenant_name: room.tenant_name || '',
              contact_number: room.contact_number || '',
              move_in_date: room.move_in_date || '',
              room_rate: room.room_rate || 0,
            };
          }
        }
        return next;
      });

      setBillEditDrafts((previous) => {
        const next = { ...previous };
        for (const room of roomData) {
          if (!next[room.id]) {
            next[room.id] = {
              electricity_reading: '',
              water_reading: '',
            };
          }
        }
        return next;
      });
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
  const markUnpaid = async (billId) => runAction(() => apiRequest(`/api/bills/${billId}/mark-unpaid`, { method: 'POST', body: JSON.stringify({ notes: 'Unpaid via admin webapp' }) }, token));
  const sendReminder = async (billId) => runAction(() => apiRequest(`/api/bills/${billId}/send-reminder`, { method: 'POST' }, token));
  const sendAllReminders = async () => runAction(() => apiRequest('/api/bills/send-reminder-all', { method: 'POST' }, token));

  const updateTenantDraft = (roomId, field, value) => {
    setTenantDrafts((previous) => ({
      ...previous,
      [roomId]: {
        ...(previous[roomId] || {}),
        [field]: value,
      },
    }));
  };

  const saveTenant = async (roomId) => {
    const draft = tenantDrafts[roomId] || {};
    await runAction(() =>
      apiRequest(`/api/tenants/${roomId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tenant_name: draft.tenant_name,
          contact_number: draft.contact_number,
          move_in_date: draft.move_in_date,
          room_rate: draft.room_rate,
        }),
      }, token)
    );
  };

  const clearTenant = async (roomId) => runAction(() => apiRequest(`/api/tenants/${roomId}/clear`, { method: 'POST' }, token));

  const updateBillDraft = (roomId, field, value) => {
    setBillEditDrafts((previous) => ({
      ...previous,
      [roomId]: {
        ...(previous[roomId] || {}),
        [field]: value,
      },
    }));
  };

  const editLatestBill = async (roomId) => {
    const draft = billEditDrafts[roomId] || {};
    await runAction(() =>
      apiRequest(`/api/readings/${roomId}/edit-latest`, {
        method: 'POST',
        body: JSON.stringify({
          electricity_reading: draft.electricity_reading,
          water_reading: draft.water_reading,
        }),
      }, token)
    );

    setBillEditDrafts((previous) => ({
      ...previous,
      [roomId]: {
        electricity_reading: '',
        water_reading: '',
      },
    }));
  };

  const billRows = filteredRooms.filter((room) => room.latest_bill_id);

  const renderHome = () => (
    <>
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

      <section className="card">
        <div className="section-head">
          <h3>Quick Actions</h3>
          <button className="ghost-btn" onClick={sendAllReminders}>Send All Reminders</button>
        </div>
        <div className="quick-stats">
          <button className="pill" onClick={() => setActiveTab('add')}>Register Tenant</button>
          <button className="pill" onClick={() => setActiveTab('bills')}>Review Bills</button>
          <button className="pill" onClick={() => setActiveTab('tenants')}>Manage Tenants</button>
        </div>
      </section>
    </>
  );

  const renderBills = () => (
    <>
      <section className="filter-pills">
        <button className={`pill ${activeFilter === 'all' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('all')}>All</button>
        <button className={`pill ${activeFilter === 'unpaid' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('unpaid')}>Unpaid</button>
        <button className={`pill ${activeFilter === 'paid' ? 'pill--active' : ''}`} onClick={() => setActiveFilter('paid')}>Paid</button>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>Bills</h3>
          <button className="ghost-btn" onClick={sendAllReminders}>Send All Reminders</button>
        </div>

        {!billRows.length ? <p className="muted">No bills available yet.</p> : null}

        {billRows.map((room) => (
          <div className="transaction-item" key={room.id}>
            <div className="transaction-icon">{room.room_number}</div>
            <div className="grow">
              <p>{room.tenant_name || 'VACANT'}</p>
              <p className="muted">{room.latest_bill_period_start} to {room.latest_bill_period_end}</p>
              <div className="row-actions">
                <input
                  placeholder="Corrected Elec"
                  value={billEditDrafts[room.id]?.electricity_reading || ''}
                  onChange={(e) => updateBillDraft(room.id, 'electricity_reading', e.target.value)}
                />
                <input
                  placeholder="Corrected Water"
                  value={billEditDrafts[room.id]?.water_reading || ''}
                  onChange={(e) => updateBillDraft(room.id, 'water_reading', e.target.value)}
                />
              </div>
              <div className="row-actions">
                <button className="mini-btn" onClick={() => editLatestBill(room.id)}>Edit Bill</button>
                <button className="mini-btn" onClick={() => sendReminder(room.latest_bill_id)}>SMS</button>
                {room.latest_bill_status !== 'paid' ? <button className="mini-btn" onClick={() => markPaid(room.latest_bill_id)}>Paid</button> : null}
                {room.latest_bill_status === 'paid' ? <button className="mini-btn" onClick={() => markUnpaid(room.latest_bill_id)}>Unpaid</button> : null}
              </div>
            </div>
            <div className="amount-col">
              <p className={room.latest_bill_status === 'paid' ? 'transaction-amount--positive' : 'transaction-amount--negative'}>
                PHP {Number(room.latest_bill_total || 0).toFixed(2)}
              </p>
              <p className="muted">{String(room.latest_bill_status || 'unpaid').toUpperCase()}</p>
            </div>
          </div>
        ))}
      </section>
    </>
  );

  const renderAdd = () => (
    <>
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
    </>
  );

  const renderStats = () => {
    const maxAmount = Math.max(...billRows.map((room) => Number(room.latest_bill_total || 0)), 1);

    return (
      <section className="card">
        <h3>Latest Bill Amounts by Room</h3>
        {!billRows.length ? <p className="muted">No bill data yet.</p> : null}
        <div className="bars-wrap">
          {billRows.slice(0, 8).map((room) => {
            const amount = Number(room.latest_bill_total || 0);
            const height = Math.max(14, Math.round((amount / maxAmount) * 120));
            return (
              <div key={room.id} className="bar-col">
                <div className="bar" style={{ height: `${height}px` }} />
                <span>{room.room_number}</span>
                <small>PHP {amount.toFixed(0)}</small>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderTenants = () => (
    <section className="card">
      <h3>Tenants</h3>
      {rooms.map((room) => (
        <div className="tenant-edit" key={room.id}>
          <p><b>{room.room_number}</b> - {room.tenant_name || 'VACANT'}</p>
          <input
            placeholder="Tenant Name"
            value={tenantDrafts[room.id]?.tenant_name || ''}
            onChange={(e) => updateTenantDraft(room.id, 'tenant_name', e.target.value)}
          />
          <input
            placeholder="Contact Number"
            value={tenantDrafts[room.id]?.contact_number || ''}
            onChange={(e) => updateTenantDraft(room.id, 'contact_number', e.target.value)}
          />
          <input
            placeholder="Move in Date"
            value={tenantDrafts[room.id]?.move_in_date || ''}
            onChange={(e) => updateTenantDraft(room.id, 'move_in_date', e.target.value)}
          />
          <input
            placeholder="Room Rate"
            value={tenantDrafts[room.id]?.room_rate ?? ''}
            onChange={(e) => updateTenantDraft(room.id, 'room_rate', e.target.value)}
          />
          <div className="row-actions">
            <button className="mini-btn" onClick={() => saveTenant(room.id)}>Save</button>
            <button className="mini-btn" onClick={() => clearTenant(room.id)}>Clear</button>
          </div>
        </div>
      ))}
    </section>
  );

  return (
    <div className="app-shell">
      <header className="header card">
        <div>
          <p className="muted">Good evening</p>
          <h2>{email}</h2>
        </div>
        <button className="ghost-btn" onClick={onLogout}>Logout</button>
      </header>

      {activeTab === 'home' ? renderHome() : null}
      {activeTab === 'bills' ? renderBills() : null}
      {activeTab === 'add' ? renderAdd() : null}
      {activeTab === 'stats' ? renderStats() : null}
      {activeTab === 'tenants' ? renderTenants() : null}

      {message ? <p className="ok-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      <nav className="bottom-nav">
        <button className={`nav-item ${activeTab === 'home' ? 'nav-item--active' : ''}`} onClick={() => setActiveTab('home')}>Home</button>
        <button className={`nav-item ${activeTab === 'bills' ? 'nav-item--active' : ''}`} onClick={() => setActiveTab('bills')}>Bills</button>
        <button className="nav-btn--add" onClick={() => setActiveTab('add')}>+</button>
        <button className={`nav-item ${activeTab === 'stats' ? 'nav-item--active' : ''}`} onClick={() => setActiveTab('stats')}>Stats</button>
        <button className={`nav-item ${activeTab === 'tenants' ? 'nav-item--active' : ''}`} onClick={() => setActiveTab('tenants')}>Tenants</button>
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
