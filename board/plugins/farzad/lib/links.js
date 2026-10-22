'use strict';
// Explicit link state machine (CONTRACT.md section 3, "Link states") and clock offset estimate.
//   unreachable --first answer--> initializing --2 answers in a row--> reachable
//   reachable --3 missed heartbeats--> unreachable (failure)
//   reachable --peer says restarting--> restarting --answer within grace--> reachable
//                                                  \-- no answer after grace --> unreachable
//   any --peer says leaving / link unused--> disabled
const HEARTBEAT = { intervalMs: 1000, missesBeforeDown: 3, restartGraceMs: 10000 };
const SYNC_LIMIT_MS = 100;

class Link {
  constructor(from, to) {
    this.from = from;
    this.to = to;
    this.key = `${from}>${to}`;
    this.state = 'unreachable';
    this.okStreak = 0;
    this.misses = 0;
    this.offsetMs = null;
    this.clockSync = null;
    this.lastHeartbeatTs = null;
    this.restartTs = null;
    this.inflight = false;
  }

  view(now) {
    return {
      from: this.from, to: this.to, state: this.state, clockSync: this.clockSync, offsetMs: this.offsetMs, lastHeartbeatTs: this.lastHeartbeatTs,
      misses: this.misses, heartbeatAgeMs: this.lastHeartbeatTs === null ? null : now - this.lastHeartbeatTs,
    };
  }
}

function move(link, to, failure = false) {
  const from = link.state;
  if (from === to) return null;
  link.state = to;
  if (to !== 'restarting') link.restartTs = null;
  return { link, from, to, failure };
}

// A heartbeat answer. Times: sentTs/answerTs on the sender's clock, receivedTs/ts on the peer's clock.
// beatStartTs (local Date.now()) lets a restarting link ignore answers to beats sent before the announcement.
function onAnswer(link, sentTs, receivedTs, ts, answerTs, beatStartTs) {
  if (link.state === 'restarting' && typeof beatStartTs === 'number' && link.restartTs !== null && beatStartTs <= link.restartTs) return null;
  if (typeof receivedTs === 'number' && typeof ts === 'number') {
    link.offsetMs = Math.round(((receivedTs - sentTs) + (ts - answerTs)) / 2);
    link.clockSync = Math.abs(link.offsetMs) <= SYNC_LIMIT_MS ? 'in' : 'out';
  }
  link.lastHeartbeatTs = Date.now();
  link.misses = 0;
  link.okStreak += 1;
  switch (link.state) {
    case 'unreachable': return move(link, link.okStreak >= 2 ? 'reachable' : 'initializing');
    case 'initializing': return link.okStreak >= 2 ? move(link, 'reachable') : null;
    case 'restarting': return move(link, 'reachable');
    default: return null;
  }
}

function onMiss(link, now) {
  link.okStreak = 0;
  link.misses += 1;
  if (link.state === 'restarting') {
    return now - link.restartTs >= HEARTBEAT.restartGraceMs ? move(link, 'unreachable') : null;
  }
  if (link.misses < HEARTBEAT.missesBeforeDown) return null;
  if (link.state === 'reachable') return move(link, 'unreachable', true);
  if (link.state === 'initializing') return move(link, 'unreachable');
  return null;
}

// The peer announced its own state in a heartbeat it sent to us.
function onPeerState(link, peerState, now) {
  if (peerState === 'leaving') return move(link, 'disabled');
  if (peerState === 'restarting' && link.state !== 'disabled') {
    const t = move(link, 'restarting');
    link.restartTs = now;
    link.okStreak = 0;
    return t;
  }
  return null;
}

// Mark a link down without counting it as a failure (killed sender, revive, rebuild).
function forceDown(link) {
  link.okStreak = 0;
  link.misses = 0;
  return move(link, 'unreachable');
}

module.exports = { HEARTBEAT, Link, onAnswer, onMiss, onPeerState, forceDown };
