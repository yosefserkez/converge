// Compile-time checks only: the real query results must satisfy the UI DTOs in
// shared/dto.ts. This module exports nothing at run time.
import type { CandidateDetail, EventsPage, ProjectSummary, ProposalDetail, SessionListItem } from '../shared/dto.ts';
import type { ProjectCoordinator } from './coordinator/index.ts';
import type { listEvents } from './coordinator/queries.ts';

type Assert<T extends true> = T;
type Satisfies<A, B> = [A] extends [B] ? true : false;

export type DtoChecks = [
  Assert<Satisfies<ReturnType<ProjectCoordinator['candidateView']>, CandidateDetail>>,
  Assert<Satisfies<Awaited<ReturnType<ProjectCoordinator['getProposal']>>, ProposalDetail>>,
  Assert<Satisfies<Awaited<ReturnType<ProjectCoordinator['getProjectSummary']>>, ProjectSummary>>,
  Assert<Satisfies<Awaited<ReturnType<ProjectCoordinator['listSessions']>>[number], SessionListItem>>,
  Assert<Satisfies<ReturnType<typeof listEvents>, EventsPage>>,
];
