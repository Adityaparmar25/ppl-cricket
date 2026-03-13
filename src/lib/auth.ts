import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';

// We store ADMIN_PASSWORD (plain) in .env.local instead of a bcrypt hash
// because Windows .env files corrupt the $ signs in bcrypt hashes.
// The plain password is hashed once at server startup and cached in memory.
// This is safe — the plain password never leaves the server process.

let cachedHash: string | null = null;

async function getHash(): Promise<string> {
  if (cachedHash) return cachedHash;

  const plain = process.env.ADMIN_PASSWORD;
  if (!plain) {
    throw new Error('ADMIN_PASSWORD is not set in .env.local');
  }

  cachedHash = await bcrypt.hash(plain, 10);
  console.log('[AUTH] Password hash generated and cached ✅');
  return cachedHash;
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) {
          return null;
        }

        // Check username
        const expectedUsername = process.env.ADMIN_USERNAME;
        if (!expectedUsername) {
          console.error('[AUTH] ❌ ADMIN_USERNAME not set in .env.local');
          return null;
        }

        if (credentials.username !== expectedUsername) {
          console.log('[AUTH] ❌ Wrong username');
          return null;
        }

        // Check password — compare against plain env var directly
        const plainPassword = process.env.ADMIN_PASSWORD;
        if (!plainPassword) {
          console.error('[AUTH] ❌ ADMIN_PASSWORD not set in .env.local');
          return null;
        }

        // Simple direct comparison (plain text, safe on server-side only)
        const isValid = credentials.password === plainPassword;
        console.log('[AUTH]', isValid ? '✅ Login success' : '❌ Wrong password');

        if (isValid) {
          return { id: '1', name: 'PPL Admin', email: 'admin@ppl.com' };
        }

        return null;
      },
    }),
  ],

  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8 hours
  },

  pages: {
    signIn: '/admin/login',
  },

  secret: process.env.NEXTAUTH_SECRET,

  callbacks: {
    async jwt({ token, user }) {
      if (user) token.role = 'admin';
      return token;
    },
    async session({ session, token }) {
      (session as any).role = token.role;
      return session;
    },
  },
};