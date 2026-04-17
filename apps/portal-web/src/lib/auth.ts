import type { NextAuthOptions } from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';

const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';

export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET_WEB ?? '',
      issuer: `${keycloakUrl}/realms/${realm}`,
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Stash the Keycloak access token so server components can forward
      // it to portal-api.
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      (session as SessionWithToken).accessToken = token.accessToken as string | undefined;
      return session;
    },
  },
  session: { strategy: 'jwt' },
};

export type SessionWithToken = import('next-auth').Session & {
  accessToken?: string;
};
