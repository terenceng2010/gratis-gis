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
      // Only attach the access token when there actually is one. Assigning
      // `undefined` is rejected under `exactOptionalPropertyTypes: true`.
      const accessToken = token.accessToken as string | undefined;
      if (accessToken) {
        (session as SessionWithToken).accessToken = accessToken;
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
};

export type SessionWithToken = import('next-auth').Session & {
  accessToken?: string;
};
