import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const {
      inningsId,
      batsmanId,
      bowlerId,
      wicketType,
      fielderId,
      nextBatsmanId,
      runs = 0,
    } = await req.json();

    if (!inningsId || !batsmanId || !bowlerId || !wicketType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const innings = await prisma.innings.findUnique({
      where:   { id: inningsId },
      include: { match: true, overs: { orderBy: { overNo: 'desc' }, take: 1 } },
    });

    if (!innings || innings.isComplete) {
      return NextResponse.json({ error: 'Innings not active' }, { status: 400 });
    }
    if (innings.match.status !== 'LIVE') {
      return NextResponse.json({ error: 'Match not live' }, { status: 400 });
    }

    const currentOverNo  = Math.floor(innings.balls / 6) + 1;
    const ballNoInOver   = (innings.balls % 6) + 1;
    const deliveryNo     = await prisma.ballEvent.count({ where: { inningsId } }) + 1;

    await prisma.$transaction(async (tx) => {
      // 1. Record wicket ball event
      await tx.ballEvent.create({
        data: {
          inningsId,
          overNo:     currentOverNo,
          ballNo:     ballNoInOver,
          deliveryNo,
          batsmanId,
          bowlerId,
          runs,
          isWicket:   true,
          wicketType,
          fielderId:  fielderId || null,
          isBoundary: false,
          isSix:      false,
        },
      });

      // 2. Update innings totals
      const newWickets = innings.wickets + 1;
      const newBalls   = innings.balls + 1;
      const isAllOut   = newWickets >= 10;

      await tx.innings.update({
        where: { id: inningsId },
        data: {
          wickets:    { increment: 1 },
          balls:      { increment: 1 },
          totalRuns:  { increment: runs },
          isComplete: isAllOut,
        },
      });

      // 3. Update current over
      await tx.over.updateMany({
        where: { inningsId, overNo: currentOverNo, isComplete: false },
        data:  { balls: { increment: 1 }, wickets: { increment: 1 }, runs: { increment: runs } },
      });

      // 4. Close current partnership
      await tx.partnership.updateMany({
        where: { inningsId, isActive: true },
        data:  { isActive: false },
      });

      // 5. If not all out, open new partnership with next batsman
      if (!isAllOut && nextBatsmanId) {
        // Find the non-striker (still batting, not the dismissed batsman)
        // We get this from audit log or last ball events
        const recentBalls = await tx.ballEvent.findMany({
          where:   { inningsId },
          orderBy: { createdAt: 'desc' },
          take:    20,
        });

        // Find non-striker = batsman who faced balls, is not dismissed, not the current batsmanId
        const outIds    = new Set<string>(recentBalls.filter((b) => b.isWicket).map((b) => b.batsmanId));
        const activeIds = new Set<string>(recentBalls.filter((b) => !b.isWicket).map((b) => b.batsmanId));
        const nonStrikerId: string | undefined = Array.from(activeIds).find(
          (id: string) => id !== batsmanId && !outIds.has(id)
        );

        if (nonStrikerId) {
          await tx.partnership.create({
            data: {
              inningsId,
              batter1Id: nextBatsmanId,
              batter2Id: nonStrikerId,
              runs:      0,
              balls:     0,
              isActive:  true,
            },
          });
        }
      }

      // 6. If all out, mark match or transition innings
      if (isAllOut) {
        if (innings.inningsNo === 1) {
          await tx.match.update({
            where: { id: innings.matchId },
            data:  { status: 'INNINGS_BREAK', currentInnings: 2 },
          });
        } else {
          // Innings 2 all out — team 1 wins
          await tx.match.update({
            where: { id: innings.matchId },
            data: {
              status:     'COMPLETE',
              resultText: `Match complete — won by runs`,
            },
          });
        }
      }

      // 7. Log to audit
      await tx.auditLog.create({
        data: {
          matchId: innings.matchId,
          action:  'WICKET',
          newValue: { batsmanId, bowlerId, wicketType, fielderId, runs, nextBatsmanId },
        },
      });
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[POST /api/admin/wicket]', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}