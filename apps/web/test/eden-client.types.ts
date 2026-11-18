// Compile-only evidence, included by the Web tsconfig; never invokes a server.
import type { Treaty } from '@elysia/eden';
import type { ApiClient, ApiError } from '../src/shared/http/eden';
import type { ProviderUpdate } from '@along/contracts';
import type { ProviderList } from '../src/features/model-settings/model/http-gateway';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;
type DynamicRoute<T> = T extends (params: never) => infer Route ? Route : never;
type Providers = ApiClient['api']['v1']['model-providers'];
type ProviderRoute = DynamicRoute<Providers>;
type UpdateBody = NonNullable<Parameters<ProviderRoute['actions']['update']['post']>[0]>;
type ProviderListEnvelope = Treaty.Data<Providers['get']>;
type Unauthorized = Extract<ApiError, { status: 401 }>;
type ConversationRoute = DynamicRoute<ApiClient['api']['v1']['conversations']>;
type Messages = Treaty.Data<ConversationRoute['messages']['get']>['data'];
type MemoryRoute = DynamicRoute<ApiClient['api']['v1']['memories']>;
type MemoryData = Treaty.Data<MemoryRoute['get']>['data'];
type ApprovalRoute = DynamicRoute<ApiClient['api']['v1']['approvals']>;
type ApprovalData = Treaty.Data<ApprovalRoute['get']>['data'];
type TaskRoute = DynamicRoute<ApiClient['api']['v1']['tasks']>;
type TaskData = Treaty.Data<TaskRoute['get']>['data'];

export type EdenEvidence = [
  Assert<NotAny<ProviderListEnvelope>>,
  Assert<NotAny<ProviderListEnvelope['data']>>,
  Assert<ProviderListEnvelope['data'] extends ProviderList ? true : false>,
  Assert<UpdateBody extends ProviderUpdate ? true : false>,
  Assert<ProviderUpdate extends UpdateBody ? true : false>,
  Assert<NotAny<Unauthorized['value']>>,
  Assert<Unauthorized['value']['data'] extends null ? true : false>,
  Assert<Unauthorized['value']['error']['code'] extends string ? true : false>,
  Assert<401 | 403 | 409 | 503 extends ApiError['status'] ? true : false>,
  Assert<number extends ApiError['status'] ? false : true>,
  Assert<NotAny<Messages>>,
  Assert<Messages['items'][number]['content'] extends string ? true : false>,
  Assert<NotAny<MemoryData>>,
  Assert<MemoryData['revision'] extends number ? true : false>,
  Assert<NotAny<ApprovalData>>,
  Assert<ApprovalData['presentation_hash'] extends string ? true : false>,
  Assert<NotAny<TaskData>>,
  Assert<TaskData['task_id'] extends string ? true : false>,
];

// @ts-expect-error Unknown routes must not be accepted by the client.
export type UnknownRoute = ApiClient['api']['v1']['missing-route'];
// @ts-expect-error Provider updates are POST-only, not arbitrary methods.
export type UnknownMethod = ProviderRoute['actions']['update']['put'];
// @ts-expect-error Success data must not degrade to an arbitrary object.
export type UnknownSuccessField = ProviderListEnvelope['data']['missing'];
// @ts-expect-error Error details retain the declared envelope, not unknown/any.
export type UnknownErrorField = Unauthorized['value']['missing'];
// @ts-expect-error A made-up payload is not a valid provider update.
export type InvalidBody = Assert<{ invalid: true } extends UpdateBody ? true : false>;
type WrongProviderParam = { provider: string } extends Parameters<Providers>[0] ? true : false;
// @ts-expect-error Dynamic routes require the declared parameter name.
export type InvalidDynamicParameter = Assert<WrongProviderParam>;
