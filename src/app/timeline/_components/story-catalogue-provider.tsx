"use client";

import { createContext, useContext } from "react";
import {
  storyChapters,
  type StoryChapter,
} from "~/app/timeline/_lib/story-progress";

export const StoryCatalogueContext =
  createContext<StoryChapter[]>(storyChapters);
export const useStoryCatalogue = () => useContext(StoryCatalogueContext);
