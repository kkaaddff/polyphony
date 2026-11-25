// /notes/* 语音便签路由(docs/voice-input.md §6)。全部要求登录;日志不含便签内容。
import { Router } from 'express';
import { addNote, listNotes, deleteNote, getRetentionDays, setRetentionDays } from '../notes.js';
import { requireAuth } from './auth.js';

function sendErr(res, e) {
  const status = { E_NOTE_INVALID: 400, E_NOTE_CONFLICT: 409 }[e.code] ?? 500;
  res.status(status).json({ error: e.message, code: e.code });
}

export function notesRouter({ onChange = () => {} } = {}) {
  const r = Router();
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.get('/settings', requireAuth, (req, res) => {
    res.json({ retentionDays: getRetentionDays(req.account.id) });
  });

  r.put('/settings', requireAuth, (req, res) => {
    try {
      res.json({ retentionDays: setRetentionDays(req.account.id, req.body?.retentionDays) });
      onChange(req.account.id);
    } catch (e) {
      sendErr(res, e);
    }
  });

  r.get('/', requireAuth, (req, res) => {
    res.json(listNotes(req.account.id, { q: req.query.q, limit: req.query.limit, before: req.query.before }));
  });

  r.post('/', requireAuth, (req, res) => {
    try {
      const { note, created } = addNote(req.account.id, {
        id: req.body?.id,
        text: req.body?.text,
        createdAt: req.body?.createdAt,
        deviceLabel: req.device.label,
      });
      res.status(created ? 201 : 200).json({ note });
      if (created) onChange(req.account.id);
    } catch (e) {
      sendErr(res, e);
    }
  });

  r.delete('/:id', requireAuth, (req, res) => {
    // 幂等:已不存在也回 200(离线删除补传/多端同时删)
    const deleted = deleteNote(req.account.id, req.params.id);
    res.json({ deleted });
    if (deleted) onChange(req.account.id);
  });

  return r;
}
