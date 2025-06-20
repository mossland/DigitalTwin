import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import bluebird from 'bluebird';
import dayjs from 'dayjs';
import { Chart } from 'chart.js/auto';
import * as THREE from 'three';
import Lottie from "lottie-react";
import { Tree, NodeRendererProps } from 'react-arborist'; // React Arborist 임포트

// --- 아래 3개 파일은 실제 프로젝트 경로에 맞게 수정해야 합니다. ---
import loadingAnim from './loading.json';
import TandemClient, { IStreamDataResponse } from './util/TandemClient';
import TandemViewer from './util/TandemViewer';
import ConnectionConfigManager, { IConnectionConfig } from './util/ConnectionConfigManager';

import styles from './App.module.scss';
import './App.scss'

const isDebug = false;
Chart.defaults.color = '#fff';
Chart.defaults.borderColor = '#ffffff26';

export interface IStreamData {
	metadata: IConnectionConfig;
	value: IStreamDataResponse;
	schema: { [key: string]: { name: string, forgeUnit: string, forgeSymbol: string, allowedValues?: { list?: string[], map?: { [key: string]: number } } } };
}

// Arborist 트리 노드 데이터 타입 정의
export interface ITreeNode {
	id: string;
	name: string;
	type: 'Level' | 'Space' | 'Asset';
	children?: ITreeNode[];
}

const schemaColorSchems = [
	'rgb(75, 192, 192)',
	'rgb(147, 38, 248)',
	'rgb(243, 50, 124)',
	'rgb(240, 206, 52)',
	'rgb(94, 242, 96)',
	'rgb(71, 116, 237)',
	'rgb(137, 93, 217)',
	'rgb(230, 69, 69)',
];

const forgeUnitToAbbr: any = {
	fahrenheit: 'F',
	cubicFeetPerMinute: 'CFM',
	percentage: '%',
}

// AssetTree 컴포넌트: React Arborist 렌더링 담당
function AssetTree({ data, isLoading, onActivate }: { data: ITreeNode[] | null, isLoading: boolean, onActivate: (node: any) => void }) {
	if (isLoading) {
		return <div className={styles.loadingText}>에셋 트리 구성 중...</div>;
	}
	if (!data) {
		return null;
	}

	// 노드 렌더러 커스터마이징 (아이콘 추가)
	const NodeRenderer = ({ node, style, dragHandle }: NodeRendererProps<ITreeNode>) => {
		const iconClass = `node-${node.data.type.toLowerCase()}`;
		return (
			<div ref={dragHandle} style={style} className={`node-row ${styles.nodeRow}`} onClick={() => node.isInternal && node.toggle()}>
				<span className={`node-name ${styles.nodeName} ${styles[iconClass]}`}>{node.data.name}</span>
			</div>
		);
	};

	return (
		<div className={styles.treeWrapper}>
			<Tree
				data={data}
				width="100%"
				height={600} // 필요에 따라 높이 조절
				openByDefault={false}
				onActivate={onActivate}
			>
				{NodeRenderer}
			</Tree>
		</div>
	);
}


function App() {
	const [tandemViewer, setTandemViewer] = useState<TandemViewer | null>(null);
	const [isReady, setIsReady] = useState<boolean>(false);
	const [showUi, setShowUi] = useState<boolean>(true);
	const [streamData, setStreamData] = useState<IStreamData | null>(null);

	// --- 트리 뷰를 위한 상태 추가 ---
	const [assetTreeData, setAssetTreeData] = useState<ITreeNode[] | null>(null);
	const [isTreeLoading, setIsTreeLoading] = useState<boolean>(false);


	const chartStreamData = useMemo(() => {
		// ... (기존 차트 데이터 로직은 변경 없음)
		if (!streamData) {
			return {};
		} else {
			return Object.keys(streamData.value).reduce((acc: any, k, idx) => {
				const chartKey = streamData.schema[k];
				if (chartKey) {
					const timeSerieseObj = streamData.value[k];
					const sortedKeys = Object.keys(timeSerieseObj).sort();
					const labels = sortedKeys.map((sk, idx) => {
						if (idx === 0) {
							return dayjs(
								new Date(Number(sk))
							).format('YYYY-MM-DD HH:mm:ss');
						} else {
							const prevSk = dayjs(Number(sortedKeys[0]));
							const curtime = dayjs(new Date(Number(sk)));
							return `+${curtime.diff(prevSk, 'minutes')} min.`;
						}

					});
					const datasets = [{
						label: `${streamData.schema[k].name} (${forgeUnitToAbbr[streamData.schema[k].forgeUnit ? streamData.schema[k].forgeUnit : 'percentage']})`,
						data: sortedKeys.map((sk) => {
							return (timeSerieseObj as any)[sk];
						}),
						fill: false,
						borderColor: schemaColorSchems[idx % schemaColorSchems.length],
						tension: 0.1,
					}];

					acc[chartKey.name] = {
						labels,
						datasets,
					};

					if (streamData.schema[k].allowedValues) {
						(acc[chartKey.name]).options = {
							plugins: {
								legend: {
									display: false,
								}
							},
							scales: {
								y: {
									ticks: {
										callback: function (v: any) {
											const normValue = v;
											const reversedObj = Object.keys(streamData.schema[k].allowedValues!.map!).reduce((acc: { [key: string]: string }, v: any) => {
												acc[streamData.schema[k].allowedValues!.map![v]] = v;
												return acc;
											}, {});
											return reversedObj[normValue];
										}
									}
								}
							}
						}
					}
				}
				return acc;
			}, {});
		}
	}, [streamData]);

	const chartRef = useRef<Chart[]>([]);

	// --- buildAssetTree 로직 구현 ---
	const buildAssetTree = useCallback(async () => {
		if (!tandemViewer) return;
		if (!(window as any).tandemViewer) return;
		setIsTreeLoading(true);

		const viewerApp = (window as any).tandemViewer.app;
		const DtConstants = (window as any).Autodesk.Tandem.DtConstants;

		try {
			console.log(viewerApp);
			const models = viewerApp.getCurrentModels();
			if (!models || models.length === 0) throw new Error("모델이 로드되지 않았습니다.");

			const model = models[0];

			const levelIds = await model.find({ query: [['props', [DtConstants.StandardPropertyNames.Category, 'eq', DtConstants.RevitCategory.Levels]]] });

			const allIdsToFetch = new Set([...levelIds]);

			const levelPromises = levelIds.map(async (levelId: string) => {
				const levelNode: ITreeNode = { id: levelId, name: '', type: 'Level', children: [] };

				const spaceIds = await model.find({
					query: [
						['keys', [levelId]],
						['traverse', 'fwd', DtConstants.DtRelations.CONTAINS],
						['props', [DtConstants.StandardPropertyNames.Category, 'in', [DtConstants.RevitCategory.Rooms, DtConstants.RevitCategory.Spaces]]]
					]
				});
				spaceIds.forEach((id: string) => allIdsToFetch.add(id));

				const spacePromises = spaceIds.map(async (spaceId: string) => {
					const spaceNode: ITreeNode = { id: spaceId, name: '', type: 'Space', children: [] };

					const assetIds = await model.find({
						query: [
							['keys', [spaceId]],
							['traverse', 'fwd', DtConstants.DtRelations.CONTAINS],
							['props', [DtConstants.StandardPropertyNames.Category, 'not in', [
								DtConstants.RevitCategory.Rooms, DtConstants.RevitCategory.Spaces, DtConstants.RevitCategory.Levels,
								DtConstants.RevitCategory.Walls, DtConstants.RevitCategory.Floors, DtConstants.RevitCategory.Ceilings
							]]]
						]
					});

					assetIds.forEach((id: string) => {
						allIdsToFetch.add(id);
						spaceNode.children?.push({ id, name: '', type: 'Asset' });
					});
					return (spaceNode.children && spaceNode.children.length > 0) ? spaceNode : null;
				});

				const spaceNodes = (await bluebird.all(spacePromises)).filter(Boolean) as ITreeNode[];
				levelNode.children = spaceNodes;
				return (levelNode.children && levelNode.children.length > 0) ? levelNode : null;
			});

			const levelNodes = (await bluebird.all(levelPromises)).filter(Boolean) as ITreeNode[];

			const allProps = await model.getQualifiedProperties(Array.from(allIdsToFetch), [DtConstants.StandardPropertyNames.Name]);

			const finalTreeData = levelNodes.map(node => {
				const populateNames = (n: ITreeNode): ITreeNode => {
					n.name = allProps[n.id]?.[DtConstants.StandardPropertyNames.Name] || `Unnamed (${n.type})`;
					if (n.children) {
						n.children.forEach(populateNames);
					}
					return n;
				};
				return populateNames(node);
			});

			setAssetTreeData(finalTreeData);

		} catch (error: any) {
			console.error("에셋 트리 구성 중 오류 발생:", error);
			// setError(error.message); // 필요 시 에러 상태 추가
		} finally {
			setIsTreeLoading(false);
		}
	}, [tandemViewer]);

	useEffect(() => {
		// ... (기존 차트 관련 useEffect는 변경 없음)
		if (!chartStreamData || Object.keys(chartStreamData).length === 0) {
			return;
		}
		if (Object.keys(chartStreamData).length > 0) {
			if (chartRef.current.length > 0) {
				chartRef.current.forEach((chart) => {
					chart.destroy();
				});
			}
			Object.keys(chartStreamData).forEach((key) => {
				const config = {
					type: 'line',
					data: chartStreamData[key],
				};
				if (chartStreamData[key].options) {
					(config as any).options = chartStreamData[key].options;
				}

				const chartObj = new Chart(
					document.getElementById(`chart-${key}`) as HTMLCanvasElement,
					config,
				);
				chartRef.current.push(chartObj);
			});
		}
	}, [chartStreamData]);

	const viewerRef = useRef<HTMLDivElement>(null);
	function corruptedStringToUint8Array(str: string) {
		// ... (기존 유틸 함수 변경 없음)
		const uint8Array = new Uint8Array(str.length * 2);
		for (let i = 0; i < str.length; i++) {
			const code = str.charCodeAt(i);
			uint8Array[i * 2] = code & 0xFF;
			uint8Array[i * 2 + 1] = (code >> 8) & 0xFF;
		}
		return uint8Array;
	}
	function uint8ToBase64Url(uint8Array: Uint8Array) {
		// ... (기존 유틸 함수 변경 없음)
		let binary = '';
		uint8Array.forEach((byte: number) => binary += String.fromCharCode(byte));
		const base64 = btoa(binary);
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}
	function getClassNameByDbId(dbId: number, dbId2Class: any) {
		// ... (기존 유틸 함수 변경 없음)
		const { sid2idx, buf, idx } = dbId2Class;
		const classIdx = sid2idx[dbId] - 1; // dbId로 클래스 인덱스 얻기
		if (classIdx < 0) {
			return '';
		}
		const start = idx[classIdx];    // 시작 위치
		const end = idx[classIdx + 1];  // 끝 위치
		return buf.substring(start, end); // 클래스 이름 추출
	}

	const [allMd, setAllMd] = useState<{ [key: string]: { fileName: string } }>({});
	const [filterSelectIdx, setFilterSelectIdx] = useState<number>(0);

	const onFilterModel = useCallback((selectModelKeyword: string) => {
		// ... (기존 필터 로직 변경 없음)
		if (!tandemViewer) {
			return;
		}

		const allModels = tandemViewer.viewer.getAllModels();
	}, [tandemViewer]);

	const originalShader = useRef<any>({});

	useEffect(() => {
		const initTandemViewer = async () => {
			await ConnectionConfigManager.instance.loadData();
			if (!tandemViewer) {
				return;
			}
			await tandemViewer.initialize(viewerRef.current as HTMLElement);
			const facilityList = await tandemViewer.fetchFacilities();

			await tandemViewer.openFacility(facilityList[0]);

			// dtFacetsLoaded 콜백에서 buildAssetTree 호출
			tandemViewer.app.listeners['dtFacetsLoaded'].push({
				once: true,
				priority: 0,
				callbackFn: async (_: any) => {
					tandemViewer.viewer.setLightPreset('Dark Sky');
					tandemViewer.viewer.setDisplayEdges(false);
					tandemViewer.viewer.setGroundShadow(false);

					await buildAssetTree(); // 트리 빌드 함수 호출

					setIsReady(true);
				},
			});

			tandemViewer.viewer.listeners['aggregateSelection'].push({
				// ... (기존 선택 이벤트 리스너 변경 없음)
				once: false,
				priority: 0,
				callbackFn: async (e: any) => {
					if (e.selections.length > 0) {
						console.log(e.selections[0]);
						const model = e.selections[0].model;
						const dbId = e.selections[0].dbIdArray[0];


						console.log(`modelId: ${model.modelFacets.id}`);
						console.log(`modelUrn: ${model.modelFacets.modelUrn}`);
						console.log(`dbId: ${dbId}`);

						let extId = '';
						(model.myData.autoDbIds.extIdToIndex as Map<string, number>).forEach((value, key) => {
							if (value === dbId) {
								extId = uint8ToBase64Url(corruptedStringToUint8Array(key));
							}
						});
						console.log(`extId: ${extId}`);

						const className = getClassNameByDbId(dbId, model.myData.dbId2Class);
						console.log(`className: ${className}`);

						const data = await TandemClient.instance.scanModel(model.modelFacets.modelUrn);
						const scanData = data.filter((d) => {
							if (typeof d === 'string') {
								return false;
							} else {
								if (d.k && d.k === extId) {
									return true;
								}
							}
						});
						console.log(scanData);
						const conn = scanData.map((sd) => {
							const connectionConfig: IConnectionConfig[] = [];
							Object.values(sd).filter((sdv: any[]) => {
								if (typeof sdv[0] === typeof 'string') {
									const config = ConnectionConfigManager.instance.fetchDataFromName(sdv[0]);
									if (config.length > 0) {
										config.forEach((c) => {
											connectionConfig.push(c);
										});
									};
									return config.length > 0;
								} else {
									return false;
								}
							});
							return connectionConfig;
						});
						const connList = conn.reduce((acc: IConnectionConfig[], c) => {
							acc.push(...c);
							return acc;
						}, []);

						if (connList.length > 0) {
							console.log(connList[0]);
							const streamData: IStreamDataResponse | null = await TandemClient.instance.getStreamData(connList[0], model.modelFacets.modelUrn);
							if (!streamData) {
								return;
							}
							const rawSchema = await bluebird.map(Object.keys(streamData), async (sdKey) => {
								return TandemClient.instance.getModelSchema(model.modelFacets.modelUrn, sdKey);
							});
							if (streamData) {
								const schemaIdName = rawSchema.reduce((acc: { [key: string]: { name: string, forgeUnit: string, forgeSymbol: string, allowedValues?: { list?: string[], map?: { [key: string]: number } } } }, s: any) => {
									if (s.attributes) {
										s.attributes.forEach((attr: any) => {
											if (attr && attr.id && attr.name) {
												acc[attr.id] = {
													name: attr.name,
													forgeUnit: attr.forgeUnit || '',
													forgeSymbol: attr.forgeSymbol || '',
												};
												if (attr.allowedValues) {
													acc[attr.id].allowedValues = attr.allowedValues;
												}
											}
										});
									}
									return acc;
								}, {} as { [key: string]: { name: string, forgeUnit: string, forgeSymbol: string, allowedValues?: { list?: string[], map?: { [key: string]: number } } } });
								setStreamData({
									metadata: connList[0],
									value: streamData,
									schema: schemaIdName,
								});
								setShowUi(true);
							}
						}
					}
				},
			});
		};
		if (!tandemViewer) {
			const v = TandemViewer.instance;
			setTandemViewer(_ => v);
			(window as any).tandemViewer = v;
		} else if (!tandemViewer.isInitialized) {
			initTandemViewer();
		}

		return () => {
			if (tandemViewer) {
				tandemViewer.viewer.listeners['aggregateSelection'].forEach((listener: any) => {
					listener.callbackFn = () => { };
				});
			}
		}
	}, [tandemViewer, buildAssetTree]); // buildAssetTree를 의존성 배열에 추가

	// 트리 노드 클릭 핸들러
	const onActivateNode = useCallback(({ node }: { node: any }) => {
		if (tandemViewer && node.data.id) {
			console.log(`노드 선택: ${node.data.name} (${node.data.id})`);
			tandemViewer.app.setSelection([node.data.id], true);
			tandemViewer.app.viewer.fitToView([node.data.id]);
		}
	}, [tandemViewer]);


	return (
		<>
			<div className={styles.viewerContainer}>
				<div id={styles.viewer} ref={viewerRef}></div>
				{
					!isReady && (
						<div className={styles.loadingContainer}>
							<div className={styles.textContainer}>
								<h1>MossLab</h1>
								<h2>Digital Twin</h2>
							</div>
							<div className={styles.animWrapper}>
								<Lottie animationData={loadingAnim} loop={true} />
							</div>
							<div className={styles.loadingSpinner}></div>
						</div>
					)
				}
			</div>
			<section className={styles.customContainer}>
				{ /* --- 필터와 트리 뷰를 감싸는 사이드바 추가 --- */}
				<div className={styles.sidebar}>
					<div className={styles.filterContainer}>
						<h6>Filter</h6>
						<div className={styles.filterItem}>
							<button className={[styles.filterButton, filterSelectIdx === 0 ? styles.selected : ''].join(' ')}>All</button>
						</div>
						{
							Object.keys(allMd).map((key, idx) => {
								return (
									<div className={styles.filterItem} key={key}>
										<button className={[styles.filterButton, filterSelectIdx === idx + 1 ? styles.selected : ''].join(' ')}>{allMd[key].fileName.replace(/Snowdon Towers Sample/, '').replace(/\.rvt/, '')}</button>
									</div>
								)
							})
						}
					</div>
					<AssetTree
						data={assetTreeData}
						isLoading={isTreeLoading}
						onActivate={onActivateNode}
					/>
				</div>
				{
					showUi && (
						<div className={styles.uiContainer}>
							{
								streamData ?
									<div className={styles.uiCard}>
										<div className={styles.cardHead}>
											<h1>{streamData?.metadata.Name}</h1>
											<div className={styles.subtitle}>
												{streamData?.metadata["Assembly Code"]} / {streamData?.metadata["Classification"]} / {streamData?.metadata.fullId}
											</div>
										</div>
										<div className={styles.cardBody}>
											<div className={styles.cardBodyItem}>

												{
													Object.keys(chartStreamData).map((key) => {
														return (<div className={styles.chartWrapper} key={key}>
															<h2>{key}</h2>
															<canvas id={`chart-${key}`}></canvas>
														</div>);
													})
												}

												{isDebug && (
													<p>
														{JSON.stringify(chartStreamData)}
													</p>
												)}
											</div>
										</div>
									</div>
									:
									null
							}

						</div>
					)
				}
			</section>
		</>
	)
}

export default App
