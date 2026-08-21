// Ported from ai-mentor/server/services/analytics.js — only logEvent/readEvents,
// the pieces GET /student/:id/performance needs. Same analytics_events table,
// same Supabase project as the monolith wrote to.
const crypto  = require('crypto');
const supabase = require('./supabase');

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

async function logEvent(eventType, payload = {}) {
  try {
    const record = {
      id:         crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
      event_type: eventType,
      timestamp:  new Date().toISOString(),
      user_email: normalizeEmail(payload.userEmail),
      role:       payload.role       || '',
      source:     payload.source     || '',
      page:       payload.page       || '',
      path:       payload.path       || '',
      status:     payload.status     || '',
      latency_ms: typeof payload.latencyMs === 'number' ? payload.latencyMs : null,
      model:      payload.model      || '',
      topic:      payload.topic      || '',
      subject:    payload.subject    || '',
      grade:      payload.grade      || '',
      score:      typeof payload.score === 'number' ? payload.score : null,
      comment:    payload.comment    || '',
      meta:       payload.meta       || {},
    };
    const { error } = await supabase.from('analytics_events').insert(record);
    if (error) throw error;
    return mapRow(record);
  } catch (err) {
    console.error('[analytics] logEvent error:', err?.message);
    return null;
  }
}

async function readEvents(filters = {}) {
  try {
    let query = supabase
      .from('analytics_events')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(filters.limit || 5000);

    if (filters.userEmail) query = query.eq('user_email', normalizeEmail(filters.userEmail));
    if (filters.eventType) query = query.eq('event_type', filters.eventType);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapRow);
  } catch (err) {
    console.error('[analytics] readEvents error:', err?.message);
    return [];
  }
}

function mapRow(e) {
  return {
    id:        e.id,
    eventType: e.event_type,
    timestamp: e.timestamp,
    userEmail: e.user_email,
    role:      e.role      || '',
    source:    e.source    || '',
    page:      e.page      || '',
    path:      e.path      || '',
    status:    e.status    || '',
    latencyMs: e.latency_ms,
    model:     e.model     || '',
    topic:     e.topic     || '',
    subject:   e.subject   || '',
    grade:     e.grade     || '',
    score:     e.score,
    comment:   e.comment   || '',
    meta:      e.meta      || {},
  };
}

module.exports = { logEvent, readEvents };
