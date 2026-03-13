'use client';

import { useState, useEffect } from 'react';
import ScorePad from '@/components/admin/ScorePad';
import WicketModal from '@/components/admin/WicketModal';
import UndoButton from '@/components/admin/UndoButton';
import BowlerSelector from '@/components/admin/BowlerSelector';
import type { MatchState, InningsState } from '@/types/cricket';

export default function AdminPanel() {
  const [match, setMatch]                   = useState<MatchState | null>(null);
  const [showWicketModal, setShowWicketModal] = useState(false);
  const [showBowlerModal, setShowBowlerModal] = useState(false);
  const [loading, setLoading]               = useState(false);
  const [lastAction, setLastAction]         = useState(0); // timestamp for undo timer

  // ── derived state ──────────────────────────────────────────────────────────
  const currentInnings: InningsState | undefined =
    match == null
      ? undefined
      : match.currentInnings === 1
        ? match.innings1
        : match.innings2;

  const striker    = currentInnings?.currentBatsmen.find((b) => b.isOnStrike);
  const nonStriker = currentInnings?.currentBatsmen.find((b) => !b.isOnStrike);

  // Fielding team players for bowler selector
  const fieldingTeam =
    match && currentInnings
      ? match.team1.id === currentInnings.battingTeamId
        ? match.team2
        : match.team1
      : null;

  // ── fetch match state ──────────────────────────────────────────────────────
  async function fetchMatch() {
    const data = await fetch('/api/match').then((r) => r.json());
    setMatch(data);
  }

  useEffect(() => { fetchMatch(); }, []);

  // ── submit a ball event ────────────────────────────────────────────────────
  async function submitBall(payload: Record<string, unknown>) {
    if (loading) return;

    // Guard — must have striker and bowler before allowing scoring
    if (!striker?.playerId) {
      alert('No striker found. Check that openers were selected in setup.');
      return;
    }
    if (!currentInnings?.currentBowler?.playerId) {
      alert('No bowler found. Check that opening bowler was selected in setup.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/ball', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          ...payload,
      inningsId:      currentInnings?.id  ?? '',
          batsmanId:      striker?.playerId   ?? '',
          bowlerId:       currentInnings?.currentBowler?.playerId ?? '',
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      // Safe JSON parse — server may return empty body on 500
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { /* empty body */ }

      if (!res.ok) {
        alert(`Error: ${String(data?.error ?? 'Something went wrong')}`);
      } else {
        setLastAction(Date.now());
        // If over just completed, prompt for next bowler
        if (data?.overJustCompleted) setShowBowlerModal(true);
        await fetchMatch();
      }
    } catch (err) {
      alert('Network error — check your connection');
    } finally {
      setLoading(false);
    }
  }

  // ── undo ───────────────────────────────────────────────────────────────────
  async function handleUndo() {
    await fetch('/api/admin/ball/undo', { method: 'POST' });
    await fetchMatch();
  }

  // ── loading / no match ─────────────────────────────────────────────────────
  if (!match) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-400 animate-pulse">Loading match...</p>
      </div>
    );
  }

  const isLive = match.status === 'LIVE';

  return (
    <div className="max-w-lg mx-auto px-3 pb-8 pt-4 space-y-4">

      {/* ── Header ── */}
      <div className="card-dark p-4 text-center">
        <p className="text-xs text-[#F5A623] uppercase tracking-widest mb-1">
          🏏 Admin Panel — {match.title}
        </p>
        <p className="text-sm text-gray-500">
          {match.team1.shortName} vs {match.team2.shortName}
        </p>

        {currentInnings ? (
          <>
            <p
              className="text-5xl font-black text-[#E8510A] mt-2 tabular-nums"
              style={{ textShadow: '0 0 20px #FF6B2B' }}
            >
              {currentInnings.totalRuns}/{currentInnings.wickets}
            </p>
            <p className="text-gray-400 text-sm mt-1">
              ({currentInnings.overs} Ov) &nbsp;·&nbsp; CRR {currentInnings.currentRunRate.toFixed(2)}
            </p>
            {currentInnings.target && (
              <p className="text-xs text-gray-400 mt-1">
                Target {currentInnings.target} &nbsp;·&nbsp; Need{' '}
                <span className="text-white font-bold">
                  {Math.max(0, currentInnings.target - currentInnings.totalRuns)}
                </span>
                {' '}off{' '}
                <span className="text-white font-bold">
                  {match.totalOvers * 6 - currentInnings.balls}
                </span>
                {' '}balls
              </p>
            )}
          </>
        ) : (
          <div className="mt-3">
            <p className="text-gray-400 mb-2">Match not started</p>
            <a
              href="/admin/setup"
              className="inline-block bg-[#E8510A] text-white px-6 py-2 rounded-lg font-bold text-sm"
            >
              ⚙️ Go to Setup
            </a>
          </div>
        )}
      </div>

      {/* ── Batsmen panel ── */}
      {(striker || nonStriker) ? (
        <div className="card-dark p-3 grid grid-cols-2 gap-3 text-sm">
          {striker && (
            <div className="bg-[#E8510A]/10 border border-[#E8510A]/30 rounded-lg p-3">
              <p className="text-[#F5A623] font-bold text-xs mb-1">★ ON STRIKE</p>
              <p className="text-white font-bold truncate text-base">{striker.displayName}</p>
              <p className="text-gray-300 text-xl font-black mt-1">
                {striker.runs}
                <span className="text-gray-500 text-xs font-normal ml-1">({striker.balls}b)</span>
              </p>
              <p className="text-gray-500 text-xs">{striker.fours}×4 · {striker.sixes}×6 · SR {striker.strikeRate.toFixed(0)}</p>
            </div>
          )}
          {nonStriker && (
            <div className="bg-white/5 border border-white/10 rounded-lg p-3">
              <p className="text-gray-500 font-bold text-xs mb-1">NON-STRIKE</p>
              <p className="text-white font-bold truncate text-base">{nonStriker.displayName}</p>
              <p className="text-gray-300 text-xl font-black mt-1">
                {nonStriker.runs}
                <span className="text-gray-500 text-xs font-normal ml-1">({nonStriker.balls}b)</span>
              </p>
              <p className="text-gray-500 text-xs">{nonStriker.fours}×4 · {nonStriker.sixes}×6 · SR {nonStriker.strikeRate.toFixed(0)}</p>
            </div>
          )}
        </div>
      ) : (
        /* Show warning if no batsmen found — helps debug */
        isLive && (
          <div className="card-dark p-3 text-center text-yellow-500 text-sm">
            ⚠️ No batsmen loaded — try refreshing or re-run setup
          </div>
        )
      )}

      {/* ── Current bowler ── */}
      {currentInnings?.currentBowler && (
        <div className="card-dark p-3 flex justify-between items-center text-sm">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Bowling</p>
            <p className="text-[#F5A623] font-bold">⚡ {currentInnings.currentBowler.displayName}</p>
          </div>
          <p className="text-gray-300 font-mono text-sm">
            {currentInnings.currentBowler.overs}-
            {currentInnings.currentBowler.maidens}-
            {currentInnings.currentBowler.runs}-
            {currentInnings.currentBowler.wickets}
          </p>
        </div>
      )}

      {/* ── Score pad ── */}
      <ScorePad
        onScore={(runs) => submitBall({ runs, isBoundary: runs === 4, isSix: runs === 6 })}
        onWide={() => submitBall({ runs: 0, isWide: true })}
        onNoBall={() => submitBall({ runs: 0, isNoBall: true })}
        onWicket={() => setShowWicketModal(true)}
        disabled={loading || !isLive}
      />

      {!isLive && (
        <p className="text-center text-xs text-gray-500">
          Scoring disabled — match status: <span className="text-[#F5A623]">{match.status}</span>
        </p>
      )}

      {/* ── Undo ── */}
      <UndoButton onUndo={handleUndo} lastActionTime={lastAction} />

      {/* ── Change bowler manually ── */}
      {isLive && fieldingTeam && (
        <button
          onClick={() => setShowBowlerModal(true)}
          className="w-full py-3 rounded-xl bg-white/5 border border-white/10
            text-gray-300 font-semibold text-sm hover:bg-white/10 transition-colors"
        >
          ⚡ Change Bowler
        </button>
      )}

      {/* ── Modals ── */}
      {showWicketModal && currentInnings && (
        <WicketModal
          match={match}
          innings={currentInnings}
          onSubmit={(wicketData) => {
            submitBall({ ...wicketData });
            setShowWicketModal(false);
          }}
          onClose={() => setShowWicketModal(false)}
        />
      )}

      {showBowlerModal && fieldingTeam && (
        <BowlerSelector
          players={fieldingTeam.players}
          lastBowlerId={currentInnings?.currentBowler?.playerId}
          onSelect={async (id) => {
            setShowBowlerModal(false);
            const res = await fetch('/api/admin/over/end', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ nextBowlerId: id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              alert(`Bowler change failed: ${data?.error ?? 'Unknown error'}`);
            }
            await fetchMatch();
          }}
          onClose={() => setShowBowlerModal(false)}
        />
      )}
    </div>
  );
}