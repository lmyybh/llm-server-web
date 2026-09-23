"use client";

import NextLink from "next/link";
import type { ComponentProps } from "react";

import { withGatewayPrefix } from "../lib/api";

/**
 * A Link that survives the gateway.
 *
 * Use this everywhere instead of ``next/link``. ``assetPrefix`` covers static
 * assets only, so without the prefix here a click navigates to a path the
 * gateway does not route.
 *
 * A test that mocks ``next/link`` still intercepts this, since that is what it
 * eventually renders.
 */
export default function Link({ href, ...rest }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink href={typeof href === "string" ? withGatewayPrefix(href) : href} {...rest} />
  );
}
