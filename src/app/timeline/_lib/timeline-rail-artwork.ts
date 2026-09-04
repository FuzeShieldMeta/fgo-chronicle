import type { TimelineCategory } from "~/app/timeline/_lib/schedule-layout";

type RailArtworkCandidate = {
  category: TimelineCategory;
  family?: { artworkUrl: string | null } | null;
};

type RailArtworkSpace = {
  availableWidth: number;
  minimumWidth: number;
};

const atlasArtworkHost = "static.atlasacademy.io";
const atlasEventBannerPath = /^\/(?:JP|NA)\/Banner\//i;

function isSupportedAtlasArtwork(artworkUrl: string) {
  try {
    const url = new URL(artworkUrl);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === atlasArtworkHost &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      atlasEventBannerPath.test(decodeURIComponent(url.pathname))
    );
  } catch {
    return false;
  }
}

export function eventArtworkUrl(family?: { artworkUrl: string | null } | null) {
  const artworkUrl = family?.artworkUrl?.trim();

  if (!artworkUrl || !isSupportedAtlasArtwork(artworkUrl)) {
    return null;
  }

  return artworkUrl;
}

export function artworkUrlAfterFailure(
  artworkUrl: string | null,
  failedArtworkUrl: string | null,
) {
  return artworkUrl && artworkUrl !== failedArtworkUrl ? artworkUrl : null;
}

export function railArtworkUrl(
  entry: RailArtworkCandidate,
  space: RailArtworkSpace,
) {
  if (entry.category !== "EVENT" || space.availableWidth < space.minimumWidth) {
    return null;
  }

  return eventArtworkUrl(entry.family);
}
