import GlobeIcon from '@sourcegraph/icons/lib/Globe'
import RepoIcon from '@sourcegraph/icons/lib/Repo'
import * as H from 'history'
import groupBy from 'lodash/groupBy'
import isEqual from 'lodash/isEqual'
import omit from 'lodash/omit'
import partition from 'lodash/partition'
import * as React from 'react'
import DownIcon from 'react-icons/lib/fa/angle-down'
import RightIcon from 'react-icons/lib/fa/angle-right'
import CloseIcon from 'react-icons/lib/md/close'
import { Link } from 'react-router-dom'
import 'rxjs/add/observable/fromPromise'
import 'rxjs/add/observable/merge'
import 'rxjs/add/operator/bufferTime'
import 'rxjs/add/operator/catch'
import 'rxjs/add/operator/concat'
import 'rxjs/add/operator/filter'
import 'rxjs/add/operator/map'
import 'rxjs/add/operator/scan'
import 'rxjs/add/operator/switchMap'
import { Observable } from 'rxjs/Observable'
import { Subject } from 'rxjs/Subject'
import { Subscription } from 'rxjs/Subscription'
import { Location } from 'vscode-languageserver-types'
import { fetchReferences } from '../backend/lsp'
import { CodeExcerpt } from '../components/CodeExcerpt'
import { VirtualList } from '../components/VIrtualList'
import { AbsoluteRepoFilePosition, RepoFilePosition } from '../repo'
import { events } from '../tracking/events'
import { parseHash, toPrettyBlobURL } from '../util/url'
import { fetchExternalReferences } from './backend'

interface ReferenceGroupProps {
    repoPath: string
    filePath: string
    refs: Location[]
    isLocal: boolean
    localRev?: string
    hidden?: boolean
}

interface ReferenceGroupState {
    hidden?: boolean
}

export class ReferencesGroup extends React.Component<ReferenceGroupProps, ReferenceGroupState> {
    constructor(props: ReferenceGroupProps) {
        super(props)
        this.state = { hidden: props.hidden }
    }

    public render(): JSX.Element | null {
        const repoPathSplit = this.props.repoPath.split('/')
        let repoPathStr = repoPathSplit.length > 1 ? repoPathSplit.slice(1).join('/') : this.props.repoPath
        repoPathStr += '/'
        const pathSplit = this.props.filePath.split('/')
        const filePart = pathSplit.pop()

        let refs: JSX.Element | null = null
        if (!this.state.hidden) {
            refs = (
                <div className='references-group__list'>
                    {
                        this.props.refs
                            .sort((a, b) => {
                                if (a.range.start.line < b.range.start.line) {
                                    return -1
                                }
                                if (a.range.start.line === b.range.start.line) {
                                    if (a.range.start.character < b.range.start.character) {
                                        return -1
                                    }
                                    if (a.range.start.character === b.range.start.character) {
                                        return 0
                                    }
                                    return 1
                                }
                                return 1
                            })
                            .map((ref, i) => {
                                const uri = new URL(ref.uri)
                                const rev = this.props.isLocal && this.props.localRev ?
                                    this.props.localRev :
                                    uri.search.substr('?'.length)
                                return (
                                    <Link
                                        to={{
                                            pathname: `/${uri.hostname + uri.pathname}${rev ? '@' + rev : ''}/-/blob/${uri.hash.substr('#'.length)}`,
                                            hash: 'L' + (ref.range.start.line + 1) + (ref.range.start.character ? ':' + (ref.range.start.character + 1) : ''),
                                            state: { referencesClick: true } /* The Blob component will only scroll on PUSH state events with this state. */
                                        }}
                                        key={i}
                                        className='references-group__reference'
                                        onClick={this.logEvent}
                                    >
                                        <CodeExcerpt
                                            repoPath={uri.hostname + uri.pathname}
                                            commitID={uri.search.substr('?'.length)}
                                            filePath={uri.hash.substr('#'.length)}
                                            position={{ line: ref.range.start.line, character: ref.range.start.character }}
                                            highlightLength={ref.range.end.character - ref.range.start.character}
                                            previewWindowExtraLines={1}
                                        />
                                    </Link>
                                )
                            })
                    }
                </div>
            )
        }

        return (
            <div className='references-group'>
                <div className='references-group__title' onClick={this.toggle}>
                    <div className='references-group__icon'>{this.props.isLocal ? <RepoIcon /> : <GlobeIcon />}</div>
                    {this.props.isLocal ? null : <div className='references-group__uri-path-part'>{repoPathStr}</div>}
                    {this.props.isLocal ? null : <div>{pathSplit.join('/')}{pathSplit.length > 0 ? '/' : ''}</div>}
                    <div className='references-group__file-path-part'>{filePart}</div>
                    {this.state.hidden ? <RightIcon className='references-group__expand-icon' /> : <DownIcon className='references-group__expand-icon' />}
                </div>
                {refs}
            </div>
        )
    }

    private toggle = () => {
        this.setState({ hidden: !this.state.hidden })
    }

    private logEvent = (): void => {
        (this.props.isLocal ? events.GoToLocalRefClicked : events.GoToExternalRefClicked).log()
    }
}

interface Props extends AbsoluteRepoFilePosition {
    location: H.Location
    history: H.History
}

interface State {
    group?: 'local' | 'external'
    references: Location[]
    loadingLocal: boolean
    loadingExternal: boolean
}

export class ReferencesWidget extends React.Component<Props, State> {
    public state: State = {
        group: 'local',
        references: [],
        loadingLocal: true,
        loadingExternal: true
    }
    private componentUpdates = new Subject<Props>()
    private subscriptions = new Subscription()

    constructor(props: Props) {
        super(props)
        const parsedHash = parseHash(props.location.hash)
        this.state.group = parsedHash.modalMode ? parsedHash.modalMode : 'local'
        this.subscriptions.add(
            this.componentUpdates
                .switchMap(props => Observable.merge(
                    Observable.fromPromise(fetchReferences(props))
                        .map(refs => ({ references: refs } as State))
                        .catch(e => {
                            console.error(e)
                            return []
                        })
                        .concat([{ loadingLocal: false } as State]),
                    fetchExternalReferences(props)
                        .map(refs => ({ references: refs } as State))
                        .catch(e => {
                            console.error(e)
                            return []
                        })
                        .concat([{ loadingExternal: false } as State])
                ))
                .bufferTime(500)
                .filter(updates => updates.length > 0)
                .scan(
                    (currState, updates) => {
                        let newState = currState
                        for (const update of updates) {
                            if (update.references) {
                                newState = { ...newState, references: newState.references.concat(update.references) }
                            } else {
                                newState = { ...newState, ...update }
                            }
                        }
                        return newState
                    },
                    { references: [], loadingLocal: true, loadingExternal: true } as State
                )
                .subscribe(state => this.setState(state))
        )
    }

    public componentDidMount(): void {
        this.componentUpdates.next(this.props)
    }

    public componentWillReceiveProps(nextProps: Props): void {
        const parsedHash = parseHash(nextProps.location.hash)
        if ((parsedHash.modalMode && parsedHash.modalMode !== this.state.group)) {
            this.setState({ group: parsedHash.modalMode })
        }
        if (isEqual(omit(this.props, 'rev'), omit(nextProps, 'rev'))) {
            this.componentUpdates.next(nextProps)
        }
    }

    public getRefsGroupFromUrl(urlStr: string): 'local' | 'external' {
        if (urlStr.indexOf('$references:local') !== -1) {
            return 'local'
        }
        if (urlStr.indexOf('$references:external') !== -1) {
            return 'external'
        }
        return 'local'
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public isLoading(group?: string): boolean {
        if (!group) {
            return this.state.loadingLocal
        }
        switch (group) {
            case 'local':
                return this.state.loadingLocal

            case 'external':
                return this.state.loadingExternal
        }
        return false
    }

    public render(): JSX.Element | null {
        const refs = this.state.references

        // References by fully qualified URI, like git://github.com/gorilla/mux?rev#mux.go
        const refsByUri = groupBy(refs, ref => ref.uri)

        const localPrefix = 'git://' + this.props.repoPath
        const [localRefs, externalRefs] = partition(Object.keys(refsByUri), uri => uri.startsWith(localPrefix))

        const localRefCount = localRefs.reduce((memo, uri) => memo + refsByUri[uri].length, 0)
        const externalRefCount = externalRefs.reduce((memo, uri) => memo + refsByUri[uri].length, 0)

        const isEmptyGroup = () => {
            switch (this.state.group) {
                case 'local':
                    return localRefs.length === 0

                case 'external':
                    return externalRefs.length === 0
            }
            return false
        }

        const ctx: RepoFilePosition = this.props

        return (
            <div className='references-widget'>
                <div className='references-widget__title-bar'>
                    <Link
                        className={'references-widget__title-bar-group' + (this.state.group === 'local' ? ' references-widget__title-bar-group--active' : '')}
                        to={toPrettyBlobURL({ ...ctx, referencesMode: 'local' })}
                        onClick={this.onLocalRefsButtonClick}>
                        This repository
                    </Link>
                    <div className='references-widget__badge'>{localRefCount}</div>
                    <Link className={'references-widget__title-bar-group' + (this.state.group === 'external' ? ' references-widget__title-bar-group--active' : '')}
                        to={toPrettyBlobURL({ ...ctx, referencesMode: 'external' })}
                        onClick={this.onShowExternalRefsButtonClick}>
                        Other repositories
                    </Link>
                    <div className='references-widget__badge'>{externalRefCount}</div>
                    <CloseIcon className='references-widget__close-icon' onClick={this.onDismiss} />
                </div>
                {
                    isEmptyGroup() && <div className='references-widget__placeholder'>
                        {this.isLoading(this.state.group) ? 'Working...' : 'No results'}
                    </div>
                }
                <div className='references-widget__groups'>
                    {
                        this.state.group === 'local' &&
                            <VirtualList initItemsToShow={3} items={localRefs.sort().map((uri, i) => {
                                const parsed = new URL(uri)
                                return (
                                    <ReferencesGroup
                                        key={i}
                                        repoPath={parsed.hostname + parsed.pathname}
                                        filePath={parsed.hash.substr('#'.length)}
                                        isLocal={true}
                                        localRev={this.props.rev}
                                        refs={refsByUri[uri]} />
                                )
                            })} />
                    }
                    {
                        this.state.group === 'external' &&
                            <VirtualList initItemsToShow={3} items={externalRefs.map((uri, i) => { /* don't sort, to avoid jerky UI as new repo results come in */
                                const parsed = new URL(uri)
                                return (
                                    <ReferencesGroup
                                        key={i}
                                        repoPath={parsed.hostname + parsed.pathname}
                                        filePath={parsed.hash.substr('#'.length)}
                                        isLocal={false}
                                        refs={refsByUri[uri]} />
                                )
                            })} />
                    }
                </div>
            </div>
        )
    }

    private onDismiss = (): void => {
        this.props.history.push(toPrettyBlobURL(this.props))
    }
    private onLocalRefsButtonClick = () => events.ShowLocalRefsButtonClicked.log()
    private onShowExternalRefsButtonClick = () => events.ShowExternalRefsButtonClicked.log()
}
