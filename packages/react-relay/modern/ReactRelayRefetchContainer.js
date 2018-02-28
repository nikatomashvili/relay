/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const React = require('React');
const RelayPropTypes = require('../classic/container/RelayPropTypes');

const areEqual = require('areEqual');
const buildReactRelayContainer = require('./buildReactRelayContainer');
const invariant = require('invariant');
const isRelayContext = require('../classic/environment/isRelayContext');
const isScalarAndEqual = require('isScalarAndEqual');
const nullthrows = require('nullthrows');

const {
  getComponentName,
  getReactComponent,
} = require('../classic/container/RelayContainerUtils');
const {profileContainer} = require('./ReactRelayContainerProfiler');
const {Observable, RelayProfiler, RelayConcreteNode} = require('RelayRuntime');

import type {FragmentSpecResolver} from '../classic/environment/RelayCombinedEnvironmentTypes';
import type {RelayEnvironmentInterface as ClassicEnvironment} from '../classic/store/RelayEnvironment';
import type {
  $RelayProps,
  ObserverOrCallback,
  GeneratedNodeMap,
  RefetchOptions,
  RelayRefetchProp,
} from './ReactRelayTypes';
import type {Disposable, Variables} from 'RelayRuntime';
import type {
  FragmentMap,
  GraphQLTaggedNode,
  IEnvironment,
  RelayContext,
  Subscription,
} from 'RelayRuntime';

type ContainerProps = $FlowFixMeProps;

type ContainerState = {
  data: {[key: string]: mixed},
  relayEnvironment: IEnvironment | ClassicEnvironment,
  relayProp: RelayRefetchProp,
  relayVariables: Variables,
  resolver: FragmentSpecResolver,
};
const containerContextTypes = {
  relay: RelayPropTypes.Relay,
};

/**
 * Composes a React component class, returning a new class that intercepts
 * props, resolving them with the provided fragments and subscribing for
 * updates.
 */
function createContainerWithFragments<
  TConfig,
  TClass: React.ComponentType<TConfig>,
>(
  Component: TClass,
  fragments: FragmentMap,
  taggedNode: GraphQLTaggedNode,
): React.ComponentType<TConfig & {componentRef?: any}> {
  const ComponentClass = getReactComponent(Component);
  const componentName = getComponentName(Component);
  const containerName = `Relay(${componentName})`;

  class Container extends React.Component<ContainerProps, ContainerState> {
    _localVariables: ?Variables;
    _refetchSubscription: ?Subscription;
    _references: Array<Disposable>;
    _relayContext: RelayContext;

    constructor(props, context) {
      super(props, context);
      const relay = assertRelayContext(context.relay);
      const {createFragmentSpecResolver} = relay.environment.unstable_internal;
      this._localVariables = null;
      this._refetchSubscription = null;
      this._references = [];
      // Do not provide a subscription/callback here.
      // It is possible for this render to be interrupted or aborted,
      // In which case the subscription would cause a leak.
      // We will add the subscription in componentDidMount().
      const resolver = createFragmentSpecResolver(
        relay,
        containerName,
        fragments,
        props,
      );
      this._relayContext = {
        environment: relay.environment,
        variables: relay.variables,
      };
      this.state = {
        data: resolver.resolve(),
        relayEnvironment: relay.environment,
        relayProp: this._buildRelayProp(relay),
        relayVariables: relay.variables,
        resolver,
      };
    }

    componentDidMount() {
      this._subscribeToNewResolver();
    }

    componentDidUpdate(prevProps: ContainerProps, prevState: ContainerState) {
      if (this.state.resolver !== prevState.resolver) {
        prevState.resolver.dispose();

        this._subscribeToNewResolver();
      }
    }

    /**
     * When new props are received, read data for the new props and subscribe
     * for updates. Props may be the same in which case previous data and
     * subscriptions can be reused.
     */
    componentWillReceiveProps(nextProps, nextContext) {
      const context = nullthrows(nextContext);
      const relay = assertRelayContext(context.relay);
      const {
        createFragmentSpecResolver,
        getDataIDsFromObject,
      } = relay.environment.unstable_internal;
      const prevIDs = getDataIDsFromObject(fragments, this.props);
      const nextIDs = getDataIDsFromObject(fragments, nextProps);

      let resolver = this.state.resolver;
      // If the environment has changed or props point to new records then
      // previously fetched data and any pending fetches no longer apply:
      // - Existing references are on the old environment.
      // - Existing references are based on old variables.
      // - Pending fetches are for the previous records.
      if (
        this.state.relayEnvironment !== relay.environment ||
        this.state.relayVariables !== relay.variables ||
        !areEqual(prevIDs, nextIDs)
      ) {
        this._references.forEach(disposable => disposable.dispose());
        this._references.length = 0;
        this._refetchSubscription && this._refetchSubscription.unsubscribe();
        this._localVariables = null;
        // Child containers rely on context.relay being mutated (for gDSFP).
        this._relayContext.environment = relay.environment;
        this._relayContext.variables = relay.variables;

        // Do not provide a subscription/callback here.
        // It is possible for this render to be interrupted or aborted,
        // In which case the subscription would cause a leak.
        // We will add the subscription in componentDidUpdate().
        resolver = createFragmentSpecResolver(
          relay,
          containerName,
          fragments,
          nextProps,
        );
        this.setState({
          relayEnvironment: relay.environment,
          relayProp: this._buildRelayProp(relay),
          relayVariables: relay.variables,
          resolver,
        });
      } else if (!this._localVariables) {
        this.state.resolver.setProps(nextProps);
      }
      const data = resolver.resolve();
      if (data !== this.state.data) {
        this.setState({data});
      }
    }

    componentWillUnmount() {
      this.state.resolver.dispose();
      this._references.forEach(disposable => disposable.dispose());
      this._references.length = 0;
      this._refetchSubscription && this._refetchSubscription.unsubscribe();
    }

    shouldComponentUpdate(nextProps, nextState, nextContext): boolean {
      // Short-circuit if any Relay-related data has changed
      if (
        nextState.data !== this.state.data ||
        nextState.relayProp !== this.state.relayProp
      ) {
        return true;
      }
      // Otherwise, for convenience short-circuit if all non-Relay props
      // are scalar and equal
      const keys = Object.keys(nextProps);
      for (let ii = 0; ii < keys.length; ii++) {
        const key = keys[ii];
        if (key === 'relay') {
          if (
            nextState.relayEnvironment !== this.state.relayEnvironment ||
            nextState.relayVariables !== this.state.relayVariables
          ) {
            return true;
          }
        } else {
          if (
            !fragments.hasOwnProperty(key) &&
            !isScalarAndEqual(nextProps[key], this.props[key])
          ) {
            return true;
          }
        }
      }
      return false;
    }

    _subscribeToNewResolver() {
      const {data, resolver} = this.state;

      // Event listeners are only safe to add during the commit phase,
      // So they won't leak if render is interrupted or errors.
      resolver.setCallback(this._handleFragmentDataUpdate);

      // External values could change between render and commit.
      // Check for this case, even though it requires an extra store read.
      const maybeNewData = resolver.resolve();
      if (data !== maybeNewData) {
        this.setState({data: maybeNewData});
      }
    }

    _buildRelayProp(relay: RelayContext): RelayRefetchProp {
      return {
        environment: relay.environment,
        refetch: this._refetch,
      };
    }

    /**
     * Render new data for the existing props/context.
     */
    _handleFragmentDataUpdate = () => {
      const profiler = RelayProfiler.profile(
        'ReactRelayRefetchContainer.handleFragmentDataUpdate',
      );
      const resolverFromThisUpdate = this.state.resolver;
      this.setState(updatedState => {
        // If this event belongs to the current data source, update.
        // Otherwise we should ignore it.
        if (resolverFromThisUpdate === updatedState.resolver) {
          return {
            data: updatedState.resolver.resolve(),
          };
        }

        return null;
      }, profiler.stop);
    };

    _getFragmentVariables(): Variables {
      const {
        getVariablesFromObject,
      } = this.context.relay.environment.unstable_internal;
      return getVariablesFromObject(
        this.context.relay.variables,
        fragments,
        this.props,
      );
    }

    _refetch = (
      refetchVariables:
        | Variables
        | ((fragmentVariables: Variables) => Variables),
      renderVariables: ?Variables,
      observerOrCallback: ?ObserverOrCallback,
      options: ?RefetchOptions,
    ): Disposable => {
      const {environment, variables: rootVariables} = assertRelayContext(
        this.context.relay,
      );
      let fetchVariables =
        typeof refetchVariables === 'function'
          ? refetchVariables(this._getFragmentVariables())
          : refetchVariables;
      fetchVariables = {...rootVariables, ...fetchVariables};
      const fragmentVariables = renderVariables
        ? {...rootVariables, ...renderVariables}
        : fetchVariables;
      const cacheConfig = options ? {force: !!options.force} : undefined;

      const observer =
        typeof observerOrCallback === 'function'
          ? {
              // callback is not exectued on complete or unsubscribe
              // for backward compatibility
              next: observerOrCallback,
              error: observerOrCallback,
            }
          : observerOrCallback || ({}: any);

      const {
        createOperationSelector,
        getRequest,
      } = this.context.relay.environment.unstable_internal;
      const query = getRequest(taggedNode);
      if (query.kind === RelayConcreteNode.BATCH_REQUEST) {
        throw new Error(
          'ReactRelayRefetchContainer: Batch request not yet ' +
            'implemented (T22955000)',
        );
      }
      const operation = createOperationSelector(query, fetchVariables);

      // Immediately retain the results of the query to prevent cached
      // data from being evicted
      const reference = environment.retain(operation.root);
      this._references.push(reference);

      this._localVariables = fetchVariables;

      // Cancel any previously running refetch.
      this._refetchSubscription && this._refetchSubscription.unsubscribe();

      // Declare refetchSubscription before assigning it in .start(), since
      // synchronous completion may call callbacks .subscribe() returns.
      let refetchSubscription;
      environment
        .execute({operation, cacheConfig})
        .mergeMap(response => {
          // Child containers rely on context.relay being mutated (for gDSFP).
          this._relayContext.environment = this.context.relay.environment;
          this._relayContext.variables = fragmentVariables;
          this.state.resolver.setVariables(fragmentVariables);
          return Observable.create(sink =>
            this.setState({data: this.state.resolver.resolve()}, () => {
              sink.next();
              sink.complete();
            }),
          );
        })
        .finally(() => {
          // Finalizing a refetch should only clear this._refetchSubscription
          // if the finizing subscription is the most recent call.
          if (this._refetchSubscription === refetchSubscription) {
            this._refetchSubscription = null;
          }
        })
        .subscribe({
          ...observer,
          start: subscription => {
            this._refetchSubscription = refetchSubscription = subscription;
            observer.start && observer.start(subscription);
          },
        });

      return {
        dispose() {
          refetchSubscription && refetchSubscription.unsubscribe();
        },
      };
    };

    getChildContext(): Object {
      return {relay: this._relayContext};
    }

    render() {
      if (ComponentClass) {
        return (
          <ComponentClass
            {...this.props}
            {...this.state.data}
            // TODO: Remove the string ref fallback.
            ref={this.props.componentRef || 'component'}
            relay={this.state.relayProp}
          />
        );
      } else {
        // Stateless functional, doesn't support `ref`
        return React.createElement(Component, {
          ...this.props,
          ...this.state.data,
          relay: this.state.relayProp,
        });
      }
    }
  }
  profileContainer(Container, 'ReactRelayRefetchContainer');
  Container.contextTypes = containerContextTypes;
  Container.displayName = containerName;

  return (Container: any);
}

function assertRelayContext(relay: mixed): RelayContext {
  invariant(
    isRelayContext(relay),
    'ReactRelayRefetchContainer: Expected `context.relay` to be an object ' +
      'conforming to the `RelayContext` interface, got `%s`.',
    relay,
  );
  return (relay: any);
}

/**
 * Wrap the basic `createContainer()` function with logic to adapt to the
 * `context.relay.environment` in which it is rendered. Specifically, the
 * extraction of the environment-specific version of fragments in the
 * `fragmentSpec` is memoized once per environment, rather than once per
 * instance of the container constructed/rendered.
 */
function createContainer<Props: {}, TComponent: React.ComponentType<Props>>(
  Component: TComponent,
  fragmentSpec: GraphQLTaggedNode | GeneratedNodeMap,
  taggedNode: GraphQLTaggedNode,
): React.ComponentType<
  $RelayProps<React.ElementConfig<TComponent>, RelayRefetchProp>,
> {
  const Container = buildReactRelayContainer(
    Component,
    fragmentSpec,
    (ComponentClass, fragments) =>
      createContainerWithFragments(ComponentClass, fragments, taggedNode),
  );
  /* $FlowFixMe(>=0.53.0) This comment suppresses an error
   * when upgrading Flow's support for React. Common errors found when
   * upgrading Flow's React support are documented at
   * https://fburl.com/eq7bs81w */
  Container.childContextTypes = containerContextTypes;
  return Container;
}

module.exports = {createContainer, createContainerWithFragments};
