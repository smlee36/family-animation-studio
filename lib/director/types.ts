import type { ReferenceCategory } from "@/lib/references/types";

export type DirectorReference = {
  id: string;
  name: string;
  category: ReferenceCategory;
  description: string;
};

export type DirectorShot = {
  id: string;
  title: string;
  action: string;
  estimatedSeconds: number;
  referenceIds: string[];
  referenceReason: string;
  startState: string;
  endState: string;
  prompt: string;
};

export type DirectorScene = {
  id: string;
  number: number;
  title: string;
  summary: string;
  setting: string;
  sceneMasterReferenceId: string;
  shots: DirectorShot[];
};

export type DirectorPlan = {
  title: string;
  summary: string;
  totalEstimatedSeconds: number;
  totalShots: number;
  scenes: DirectorScene[];
};

export type DirectorResponse = {
  plan: DirectorPlan;
  references: DirectorReference[];
};
