import upperFirst from 'lodash/upperFirst'
import * as React from 'react'
import 'rxjs/add/operator/catch'
import 'rxjs/add/operator/map'
import 'rxjs/add/operator/startWith'
import 'rxjs/add/operator/switchMap'
import { Subject } from 'rxjs/Subject'
import { Subscription } from 'rxjs/Subscription'
import { ReferencesGroup } from '../references/ReferencesWidget'
import { ParsedRouteProps } from '../util/routes'
import { searchText } from './backend'
import { parseSearchURLQuery } from './index'

interface Props extends ParsedRouteProps { }

interface State {
    results: GQL.IFileMatch[]
    loading: boolean
    searchDuration?: number
    error?: Error
}

function numberWithCommas(x: any): string {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pluralize(str: string, n: number): string {
    return `${str}${n === 1 ? '' : 's'}`
}

export class SearchResults extends React.Component<Props, State> {

    public state: State = {
        results: [],
        loading: true
    }

    private componentUpdates = new Subject<Props>()
    private subscriptions = new Subscription()

    public componentDidMount(): void {
        this.subscriptions.add(
            this.componentUpdates
                .startWith(this.props)
                .switchMap(props => {
                    const start = Date.now()
                    const searchOptions = parseSearchURLQuery(props.location.search)
                    return searchText(searchOptions)
                        .map((res: GQL.ISearchResults): State => ({ results: res.results, error: undefined, loading: false, searchDuration: Date.now() - start }))
                        .catch((error): State[] => {
                            console.error(error)
                            return [{ results: [], error, loading: false, searchDuration: undefined }]
                        })
                        // Reset to loading state
                        .startWith<State>({ results: [], error: undefined, loading: true, searchDuration: undefined })
                })
                .subscribe(
                    newState => this.setState(newState),
                    err => console.error(err)
                )
        )
    }

    public componentWillReceiveProps(newProps: Props): void {
        this.componentUpdates.next(newProps)
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public render(): JSX.Element | null {

        let alertTitle: string | undefined
        let alertDetails: string | undefined
        if (this.state.error) {
            alertTitle = 'Something went wrong!'
            alertDetails = upperFirst(this.state.error.message)
        } else if (this.state.loading) {
            alertTitle = 'Working...'
        } else if (this.state.results.length === 0) {
            alertTitle = 'No results'
        }

        let totalMatches = 0
        let totalResults = 0
        let totalFiles = 0
        let totalRepos = 0
        const seenRepos = new Set<string>()
        for (const result of this.state.results) {
            const parsed = new URL(result.resource)
            if (!seenRepos.has(parsed.pathname)) {
                seenRepos.add(parsed.pathname)
                totalRepos += 1
            }
            totalFiles += 1
            totalResults += result.lineMatches.length
        }

        return (
           <div className='search-results'>
                {
                    (alertTitle || alertDetails) &&
                        <div className='search-results__alert'>
                            {alertTitle && <h1 className='search-results__alert-title'>{alertTitle}</h1>}
                            {alertDetails && <p className='search-results__alert-details'>{alertDetails}</p>}
                        </div>
                }
                {
                    this.state.results.length > 0 &&
                        <div className='search-results__header'>
                            <div className='search-results__badge'>{numberWithCommas(totalResults)}</div>
                            <div className='search-results__label'>{pluralize('result', totalResults)} in</div>
                            <div className='search-results__badge'>{numberWithCommas(totalFiles)}</div>
                            <div className='search-results__label'>{pluralize('file', totalFiles)}  in</div>
                            <div className='search-results__badge'>{numberWithCommas(totalRepos)}</div>
                            <div className='search-results__label'>{pluralize('repo', totalRepos)} </div>
                            <div className='search-results__duration'>{this.state.searchDuration! / 1000} seconds</div>
                        </div>
                }
                {
                    this.state.results.map((result, i) => {
                        const prevTotal = totalMatches
                        totalMatches += result.lineMatches.length
                        const parsed = new URL(result.resource)
                        const repoPath = parsed.hostname + parsed.pathname
                        const filePath = parsed.hash.substr('#'.length)
                        const refs = result.lineMatches.map(match => ({
                            range: {
                                start: {
                                    character: match.offsetAndLengths[0][0],
                                    line: match.lineNumber
                                },
                                end: {
                                    character: match.offsetAndLengths[0][0] + match.offsetAndLengths[0][1],
                                    line: match.lineNumber
                                }
                            },
                            uri: result.resource,
                            repoURI: repoPath
                        }))

                        return <ReferencesGroup hidden={prevTotal > 500} repoPath={repoPath} filePath={filePath} key={i} refs={refs} isLocal={false} />
                    })
                }
            </div>
        )
    }
}
