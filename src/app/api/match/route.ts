import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { MatchState, InningsState, BallIcon } from '@/types/cricket';

// ─── helpers ────────────────────────────────────────────────────────────────
function oversDisplay(balls: number) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}
function runRate(runs: number, balls: number) {
  if (!balls) return 0;
  return parseFloat(((runs / balls) * 6).toFixed(2));
}
function reqRunRate(target: number, runs: number, ballsRemaining: number) {
  if (ballsRemaining <= 0) return 999;
  return parseFloat((((target - runs) / ballsRemaining) * 6).toFixed(2));
}

// ─── transform raw Prisma innings → InningsState ─────────────────────────────
function buildInningsState(innings: any, players: any[], totalOvers: number): InningsState {
  const events: any[] = innings.ballEvents ?? [];

  // ── current over balls (last ≤6 legal deliveries) ──
  const currentOverNo = Math.floor(innings.balls / 6) + 1;
  const currentOverEvents = events.filter((e: any) => e.overNo === currentOverNo);
  const recentBalls: BallIcon[] = currentOverEvents.map((e: any) => {
    if (e.isWicket)   return { type: 'wicket' };
    if (e.isSix)      return { type: 'six',    value: 6 };
    if (e.isBoundary) return { type: 'four',   value: 4 };
    if (e.isWide)     return { type: 'wide' };
    if (e.isNoBall)   return { type: 'noball' };
    if (e.runs === 0) return { type: 'dot' };
    return { type: 'runs', value: e.runs };
  });

  // ── batsmen stats from ball events ──
  const batsmanMap: Record<string, any> = {};
  for (const e of events) {
    if (!e.batsmanId) continue;
    if (!batsmanMap[e.batsmanId]) {
      batsmanMap[e.batsmanId] = {
        playerId: e.batsmanId,
        runs: 0, balls: 0, fours: 0, sixes: 0,
        isOnStrike: false, isOut: false, dismissalInfo: '',
      };
    }
    const b = batsmanMap[e.batsmanId];
    if (!e.isWide) {
      b.balls += 1;
      if (!e.isBye && !e.isLegBye) b.runs += e.runs;
      if (e.isBoundary) b.fours += 1;
      if (e.isSix)      b.sixes += 1;
    }
    if (e.isWicket) {
      b.isOut = true;
      b.dismissalInfo = e.wicketType ?? 'out';
    }
  }

  // ── Always seed current batsmen from active partnership ──
  // New batsman after wicket has no ball events yet — must come from partnership
  const activePartnership = innings.partnerships?.find((p: any) => p.isActive);

  // Seed BOTH batsmen from active partnership if not already in batsmanMap
  // This handles: (1) match start with no balls, (2) new batsman after wicket
  if (activePartnership) {
    for (const pid of [activePartnership.batter1Id, activePartnership.batter2Id]) {
      if (pid && !batsmanMap[pid]) {
        batsmanMap[pid] = {
          playerId: pid, runs: 0, balls: 0,
          fours: 0, sixes: 0, isOnStrike: false, isOut: false, dismissalInfo: '',
        };
      }
    }
  }

  // ── Strike rotation ──
  // Get all partnership batter IDs to identify the two current batsmen
  const currentPairIds = activePartnership
    ? [activePartnership.batter1Id, activePartnership.batter2Id].filter(Boolean)
    : [];

  // Use only ball events from the CURRENT partnership to count swaps
  // (reset swap count after each wicket / new partnership)
  const partnershipStartBall = (() => {
    // Find how many wickets fell before this partnership
    const wicketEvents = events.filter((e: any) => e.isWicket);
    const wicketsBefore = wicketEvents.length; // each wicket = new partnership
    // Count legal balls before this partnership started
    let legalBallCount = 0;
    let wicketsSeen = 0;
    for (const e of events) {
      if (wicketsSeen >= wicketsBefore) break;
      if (e.isWicket) wicketsSeen++;
      if (!e.isWide && !e.isNoBall) legalBallCount++;
    }
    return legalBallCount;
  })();

  // Balls bowled in current partnership (after last wicket)
  const lastWicketIdx = (() => {
    let idx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].isWicket) idx = i;
    }
    return idx;
  })();
  const ballsInPartnership = events
    .slice(lastWicketIdx + 1)
    .filter((e: any) => !e.isWide && !e.isNoBall);

  // Count odd-run swaps in current partnership
  let swapCount = 0;
  let overAtPartnershipStart = Math.floor(partnershipStartBall / 6);

  for (const e of ballsInPartnership) {
    if ((e.runs ?? 0) % 2 === 1) swapCount++;
  }

  // Add end-of-over swaps since partnership started
  const currentCompletedOvers = Math.floor(innings.balls / 6);
  swapCount += currentCompletedOvers - overAtPartnershipStart;

  // New batsman (batter1 of active partnership) starts on strike
  // Even swaps = batter1 on strike, odd = batter2
  const b1 = activePartnership?.batter1Id;
  const b2 = activePartnership?.batter2Id;
  strikerIdFinal = (swapCount % 2 === 0) ? (b1 ?? '') : (b2 ?? '');

  // Apply strike
  for (const b of Object.values(batsmanMap) as any[]) {
    b.isOnStrike = b.playerId === strikerIdFinal;
  }

  const currentBatsmen = Object.values(batsmanMap)
    .filter((b: any) => !b.isOut)
    .map((b: any) => {
      const p = players.find((pl) => pl.id === b.playerId);
      return {
        ...b,
        displayName: p?.displayName ?? b.playerId,
        strikeRate: b.balls ? parseFloat(((b.runs / b.balls) * 100).toFixed(1)) : 0,
      };
    });

  // ── current bowler ──
  const lastOver = innings.overs?.slice().sort((a: any, b: any) => b.overNo - a.overNo)[0];
  const currentBowler = lastOver
    ? (() => {
        const p = players.find((pl) => pl.id === lastOver.bowlerId);
        const bowlerOvers = innings.overs?.filter((o: any) => o.bowlerId === lastOver.bowlerId) ?? [];
        const totalRuns    = bowlerOvers.reduce((s: number, o: any) => s + o.runs, 0);
        const totalWickets = bowlerOvers.reduce((s: number, o: any) => s + o.wickets, 0);
        const totalBalls   = bowlerOvers.reduce((s: number, o: any) => s + o.balls, 0);
        return {
          playerId:    lastOver.bowlerId,
          displayName: p?.displayName ?? lastOver.bowlerId,
          overs:       oversDisplay(totalBalls),
          maidens:     bowlerOvers.filter((o: any) => o.maidens).length,
          runs:        totalRuns,
          wickets:     totalWickets,
          economy:     totalBalls ? parseFloat(((totalRuns / totalBalls) * 6).toFixed(2)) : 0,
        };
      })()
    : undefined;

  // ── fall of wickets ──
  const wicketEvents = events.filter((e: any) => e.isWicket);
  const fallOfWickets = wicketEvents.map((e: any, i: number) => {
    const p = players.find((pl) => pl.id === e.batsmanId);
    return {
      wicketNo:   i + 1,
      score:      0, // would need cumulative score calc — simplified
      playerName: p?.displayName ?? 'Unknown',
      over:       `${e.overNo}.${e.ballNo}`,
    };
  });

  const ballsRemaining = totalOvers * 6 - innings.balls;

  return {
    id:               innings.id,
    inningsNo:        innings.inningsNo,
    battingTeamId:    innings.battingTeamId,
    totalRuns:        innings.totalRuns,
    wickets:          innings.wickets,
    balls:            innings.balls,
    overs:            oversDisplay(innings.balls),
    currentRunRate:   runRate(innings.totalRuns, innings.balls),
    requiredRunRate:  innings.target ? reqRunRate(innings.target, innings.totalRuns, ballsRemaining) : undefined,
    target:           innings.target ?? undefined,
    extras: {
      wide:    innings.extrasWide,
      noBall:  innings.extrasNoBall,
      bye:     innings.extrasBye,
      legBye:  innings.extrasLegBye,
      total:   innings.extrasWide + innings.extrasNoBall + innings.extrasBye + innings.extrasLegBye,
    },
    currentBatsmen,
    currentBowler,
    recentBalls,
    fallOfWickets,
    isComplete: innings.isComplete,
  };
}

// ─── GET /api/match ──────────────────────────────────────────────────────────
export async function GET() {
  try {
    const raw = await prisma.match.findFirst({
      orderBy: { createdAt: 'desc' },
      include: {
        teams: { include: { players: true } },
        innings: {
          include: {
            ballEvents: { orderBy: { createdAt: 'asc' } },
            overs:       { orderBy: { overNo: 'asc' } },
            partnerships: true,
          },
        },
      },
    });

    if (!raw) {
      return NextResponse.json({ error: 'No match found' }, { status: 404 });
    }

    const team1 = raw.teams.find((t) => t.id === raw.team1Id)!;
    const team2 = raw.teams.find((t) => t.id === raw.team2Id)!;
    const allPlayers = [...(team1?.players ?? []), ...(team2?.players ?? [])];

    const innings1Raw = raw.innings.find((i) => i.inningsNo === 1);
    const innings2Raw = raw.innings.find((i) => i.inningsNo === 2);

    const matchState: MatchState = {
      id:             raw.id,
      title:          raw.title,
      status:         raw.status as any,
      totalOvers:     raw.totalOvers,
      team1: {
        id:        team1?.id ?? '',
        name:      team1?.name ?? '',
        shortName: team1?.shortName ?? '',
        players:   (team1?.players ?? []).map((p) => ({
          id:          p.id,
          name:        p.name,
          displayName: p.displayName,
          isCaptain:   p.isCaptain,
          jerseyNo:    p.jerseyNo ?? undefined,
        })),
      },
      team2: {
        id:        team2?.id ?? '',
        name:      team2?.name ?? '',
        shortName: team2?.shortName ?? '',
        players:   (team2?.players ?? []).map((p) => ({
          id:          p.id,
          name:        p.name,
          displayName: p.displayName,
          isCaptain:   p.isCaptain,
          jerseyNo:    p.jerseyNo ?? undefined,
        })),
      },
      currentInnings:  raw.currentInnings,
      tossWonById:     raw.tossWonById    ?? undefined,
      battingFirstId:  raw.battingFirstId ?? undefined,
      resultText:      raw.resultText ?? undefined,
      innings1: innings1Raw ? buildInningsState(innings1Raw, allPlayers, raw.totalOvers) : undefined,
      innings2: innings2Raw ? buildInningsState(innings2Raw, allPlayers, raw.totalOvers) : undefined,
    };

    return NextResponse.json(matchState);
  } catch (err) {
    console.error('[GET /api/match]', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}