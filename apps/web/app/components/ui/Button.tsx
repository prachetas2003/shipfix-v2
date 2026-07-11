"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "ghost" | "success";

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children: ReactNode;
}): React.ReactElement {
  return (
    <button type="button" className={`sf-btn sf-btn--${variant} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
