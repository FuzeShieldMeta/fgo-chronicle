"use client";

import Image from "next/image";
import { useState } from "react";

export function ServantThumbnail({
  url,
  size,
}: {
  url?: string | null;
  size: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span
      className="servant-thumbnail"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {url && failedUrl !== url ? (
        <Image
          src={url}
          alt=""
          width={size}
          height={size}
          sizes={`${size}px`}
          loading="lazy"
          onError={() => setFailedUrl(url)}
        />
      ) : null}
    </span>
  );
}

export function ServantIdentity({
  name,
  className,
  thumbnailUrl,
  size,
  highlighted = false,
}: {
  name: string;
  className?: string;
  thumbnailUrl?: string | null;
  size: number;
  highlighted?: boolean;
}) {
  return (
    <>
      <ServantThumbnail url={thumbnailUrl} size={size} />
      <span className="timeline-servant-description">
        {highlighted ? <strong>{name}</strong> : <span>{name}</span>}
        {className ? <small>{className}</small> : null}
      </span>
    </>
  );
}
