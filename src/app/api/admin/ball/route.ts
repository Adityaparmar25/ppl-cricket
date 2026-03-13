import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const BallSchema = z.object({
  inningsId:      z.string().min(1),
  batsmanId:      z.string().min(1),
  bowlerId:       z.string().min(1),
  runs:           z.number().min(0).max(6).default(0),
  isWide:         z.boolean().default(false),
  isNoBall:       z.boolean().default(false),
  isBye:          z.boolean().default(false),
  isLegBye:       z.boolean().default(false),
  isBoundary:     z.boolean().default(false),
  isSix:          z.boolean().default(false),
  isFreeHit:      z.boolean().default(false),
  extraRuns:      z.number().default(0),
  idempotencyKey: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Parse body
  let rawBody: unknown;
  try { rawBody = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  // Validate — fix: use .issues not .errors to avoid TS red line
  const parsed = BallSchema.safeParse(rawBody);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const d = parsed.data;

  // Load innings
  const innings = await prisma.innings.findUnique({
    where:   { id: d.inningsId },
    include: { match: true },
  });
  if (!innings)         return NextResponse.json({ error: 'Innings not found' }, { status: 404 });
  if (innings.isComplete) return NextResponse.json({ error: 'Innings already complete' }, { status: 400 });
  if (innings.match.status !== 'LIVE')
    return NextResponse.json({ error: `Match not LIVE (status: ${innings.match.status})` }, { status: 400 });

  // Positioning
  const isLegal       = !d.isWide && !d.isNoBall;
  const overNo        = Math.floor(innings.balls / 6) + 1;
  const ballNoInOver  = isLegal ? (innings.balls % 6) + 1 : 0;
  const deliveryCount = await prisma.ballEvent.count({ where: { inningsId: d.inningsId } });
  const deliveryNo    = deliveryCount + 1;

  // Run calculations
  const extraBase   = (d.isWide || d.isNoBall) ? 1 : 0;
  // fix: explicit number cast to avoid type mismatch on Prisma 'runs' field
  const batsmanRuns: number = (d.isBye || d.isLegBye || d.isWide) ? 0 : Number(d.runs);
  const totalRuns   = batsmanRuns + extraBase + Number(d.extraRuns);

  // Over / innings completion flags
  const newBalls          = isLegal ? innings.balls + 1 : innings.balls;
  const overJustCompleted = isLegal && newBalls % 6 === 0;
  const inningsEnds       = isLegal && newBalls >= innings.match.totalOvers * 6;

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Record ball event
      await tx.ballEvent.create({
        data: {
          inningsId:  d.inningsId,
          overNo,
          ballNo:     ballNoInOver,
          deliveryNo,
          batsmanId:  d.batsmanId,
          bowlerId:   d.bowlerId,
          runs:       batsmanRuns,   // fix: explicit typed number
          isWide:     d.isWide,
          isNoBall:   d.isNoBall,
          isBye:      d.isBye,
          isLegBye:   d.isLegBye,
          isBoundary: d.isBoundary,
          isSix:      d.isSix,
          isFreeHit:  d.isFreeHit,
          extraRuns:  Number(d.extraRuns),
        },
      });

      // 2. Update innings totals
      await tx.innings.update({
        where: { id: d.inningsId },
        data: {
          totalRuns:    { increment: totalRuns },
          balls:        isLegal ? { increment: 1 } : undefined,
          extrasWide:   d.isWide   ? { increment: extraBase + Number(d.extraRuns) } : undefined,
          extrasNoBall: d.isNoBall ? { increment: extraBase + Number(d.extraRuns) } : undefined,
          extrasBye:    d.isBye    ? { increment: Number(d.runs) } : undefined,
          extrasLegBye: d.isLegBye ? { increment: Number(d.runs) } : undefined,
          isComplete:   inningsEnds,
        },
      });

      // 3. Update current over
      await tx.over.updateMany({
        where: { inningsId: d.inningsId, overNo, isComplete: false },
        data: {
          runs:       { increment: totalRuns },
          balls:      isLegal ? { increment: 1 } : undefined,
          isComplete: overJustCompleted || inningsEnds,
        },
      });

      // 4. Update active partnership
      await tx.partnership.updateMany({
        where: { inningsId: d.inningsId, isActive: true },
        data: {
          runs:  { increment: totalRuns },
          balls: isLegal ? { increment: 1 } : undefined,
        },
      });

      // 5. Handle innings end
      if (inningsEnds) {
        if (innings.inningsNo === 1) {
          await tx.match.update({
            where: { id: innings.matchId },
            data:  { status: 'INNINGS_BREAK', currentInnings: 2 },
          });
        } else {
          await tx.match.update({
            where: { id: innings.matchId },
            data:  { status: 'COMPLETE', resultText: 'Match complete' },
          });
        }
      }

      // 6. Audit
      await tx.auditLog.create({
        data: {
          matchId:  innings.matchId,
          action:   'BALL',
          newValue: { overNo, ballNoInOver, batsmanRuns, totalRuns },
        },
      });
    });

    return NextResponse.json({ success: true, overJustCompleted, inningsEnds });
  } catch (err) {
    console.error('[POST /api/admin/ball]', err);
    return NextResponse.json({ error: 'Failed to record ball' }, { status: 500 });
  }
}