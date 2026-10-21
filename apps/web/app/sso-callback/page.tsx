"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { AUTH_MODE } from "../lib/api";

/** Clerk returns here after Sign in with GitHub. Dev auth does not use this route. */
export default function SsoCallbackPage(): React.ReactElement {
  if (AUTH_MODE === "dev") return <p>GitHub sign-in is not used in local dev.</p>;
  return <AuthenticateWithRedirectCallback />;
}
