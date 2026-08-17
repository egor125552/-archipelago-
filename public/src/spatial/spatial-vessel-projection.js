"use strict";

const flipPoint = value => ({x: Number(value?.x ?? value?.[0]) || 0, y: -(Number(value?.y ?? value?.[1]) || 0), z: 0});
const safeIdPart = value => String(value || "unknown").replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
const deckSpaceId = deckId => `vessel.deck.${safeIdPart(deckId)}`;

function pointInPolygon(point, outer) {
  let inside = false;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const a = outer[i], b = outer[j];
    const on = Math.abs((point.x-a.x)*(b.y-a.y)-(point.y-a.y)*(b.x-a.x)) <= 1e-9
      && point.x >= Math.min(a.x,b.x)-1e-9 && point.x <= Math.max(a.x,b.x)+1e-9
      && point.y >= Math.min(a.y,b.y)-1e-9 && point.y <= Math.max(a.y,b.y)+1e-9;
    if (on) return true;
    if (((a.y>point.y)!==(b.y>point.y)) && point.x < (b.x-a.x)*(point.y-a.y)/((b.y-a.y)||Number.EPSILON)+a.x) inside=!inside;
  }
  return inside;
}

function safeDeckPoint(deck) {
  const outer=(deck?.shape?.outer||[]).map(flipPoint);
  if (pointInPolygon({x:0,y:0},outer)) return {x:0,y:0,z:0};
  const average=outer.length?{x:outer.reduce((s,p)=>s+p.x,0)/outer.length,y:outer.reduce((s,p)=>s+p.y,0)/outer.length}:null;
  if (average&&pointInPolygon(average,outer)) return {...average,z:0};
  return outer[0] ? {...outer[0],z:0} : {x:0,y:0,z:0};
}

function deckElevations(decks) {
  const result=new Map();
  if(!decks.length)return result;
  const base=[...decks].sort((a,b)=>(Number(a.level)||0)-(Number(b.level)||0))[0];
  result.set(base.id,0);
  for(let pass=0;pass<decks.length*2;pass+=1){
    let changed=false;
    for(const deck of decks){
      if(!result.has(deck.id))continue;
      for(const connection of deck.connections||[]){
        if(result.has(connection.toDeckId))continue;
        const target=decks.find(candidate=>candidate.id===connection.toDeckId);if(!target)continue;
        const difference=(Number(target.level)||0)-(Number(deck.level)||0);
        const height=Math.max(0.1,Number(connection.traversal?.levelHeight)||3);
        result.set(target.id,result.get(deck.id)+(difference<0?-height:height));changed=true;
      }
    }
    if(!changed)break;
  }
  const baseLevel=Number(base.level)||0;
  for(const deck of decks)if(!result.has(deck.id))result.set(deck.id,((Number(deck.level)||0)-baseLevel)*3);
  return result;
}

function rootShape(decks) {
  const points=decks.flatMap(deck=>(deck.shape?.outer||[]).map(flipPoint));
  if(!points.length)return {outer:[[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],minZ:0,maxZ:30};
  const minX=Math.min(...points.map(p=>p.x))-1,maxX=Math.max(...points.map(p=>p.x))+1,minY=Math.min(...points.map(p=>p.y))-1,maxY=Math.max(...points.map(p=>p.y))+1;
  return {outer:[[minX,minY,0],[maxX,minY,0],[maxX,maxY,0],[minX,maxY,0]],minZ:0,maxZ:30};
}

function mapConnectionKind(kind){return ["door","hatch","ladder","passage"].includes(kind)?kind:kind==="gangway"?"passage":"custom";}
function mapTraversal(traversal={}){const mode=traversal.mode==="geometry"?"physical":traversal.mode==="timed"?"timed":"instant";return {mode,duration:mode==="timed"?Math.max(0,Number(traversal.duration)||0):0};}

function projectConnections(decks) {
  const result=[],seen=new Set();
  for(const deck of decks){
    for(const connection of deck.connections||[]){
      const pair=connection.reverseId?[connection.id,connection.reverseId].sort().join("|"):connection.id;if(seen.has(pair))continue;seen.add(pair);
      const target=decks.find(candidate=>candidate.id===connection.toDeckId);if(!target)continue;
      const reverse=connection.reverseId?(target.connections||[]).find(candidate=>candidate.id===connection.reverseId):null;
      const to=connection.to?flipPoint(connection.to):reverse?.from?flipPoint(reverse.from):safeDeckPoint(target);
      result.push({
        id:`vessel.connection.${safeIdPart(connection.id)}`,
        label:String(connection.label||connection.presentation?.label||"переход"),
        presentation:{label:String(connection.label||connection.presentation?.label||"переход"),description:"Проекция существующего судового перехода",role:"transition"},
        kind:mapConnectionKind(String(connection.kind||"passage")),
        from:{spaceId:deckSpaceId(deck.id),position:flipPoint(connection.from)},
        to:{spaceId:deckSpaceId(target.id),position:to},
        bidirectional:Boolean(connection.reverseId),
        states:[...(connection.states||["open","closed","locked","blocked","destroyed"])],
        initialState:String(connection.initialState||"open"),
        passableStates:[...(connection.passableStates||["open","destroyed"])],
        traversal:mapTraversal(connection.traversal),
        cost:1,
        acousticTransmission:{open:Number(connection.acoustics?.openTransmission??1),closed:Number(connection.acoustics?.closedTransmission??0.18)},
      });
    }
  }
  return result;
}

export function projectVesselDefinitionToSpatial(definition,{instanceId="template"}={}){
  if(!definition||typeof definition!=="object")throw new TypeError("vessel definition is required");
  const decks=[...(definition.decks||[])];if(!decks.length)throw new Error(`vessel ${definition.id||"unknown"} has no decks to project`);
  const elevations=deckElevations(decks),rootId="vessel.root";
  const spaces=[{
    id:rootId,label:`${definition.label||definition.id} — корпус`,presentation:{label:`${definition.label||definition.id} — корпус`,description:"Общее движущееся пространство существующего судна",role:"vehicle"},
    moving:true,transform:{position:{x:0,y:0,z:0},yaw:0},shape:rootShape(decks),anchors:[],objects:[],acoustics:{profile:"open",gain:1,lowpassHz:20000,reverb:0.04},activity:{activeRadius:80,preloadRadius:120},
  }];
  for(const deck of decks){
    const outer=(deck.shape?.outer||[]).map(point=>{const p=flipPoint(point);return [p.x,p.y,0];});
    spaces.push({
      id:deckSpaceId(deck.id),label:String(deck.label||deck.id),presentation:{label:String(deck.label||deck.id),description:"Палуба, спроецированная из существующей vessel-конфигурации",role:"vehicle"},
      parentSpaceId:rootId,transform:{position:{x:0,y:0,z:elevations.get(deck.id)||0},yaw:0},shape:{outer,minZ:0,maxZ:3},
      anchors:(deck.landmarks||[]).map(landmark=>{const p=flipPoint(landmark.position);return {id:`vessel.anchor.${safeIdPart(deck.id)}.${safeIdPart(landmark.id)}`,kind:"landmark",label:String(landmark.label||landmark.id),position:[p.x,p.y,0],navigation:landmark.navigation!==false};}),
      objects:(deck.objects||[]).map(object=>{const p=flipPoint(object.position);return {id:`vessel.object.${safeIdPart(deck.id)}.${safeIdPart(object.id)}`,kind:String(object.kind||"object"),label:String(object.label||object.id),position:[p.x,p.y,0]};}),
      acoustics:{profile:"open",gain:1,lowpassHz:18000,reverb:0.12},activity:{activeRadius:50,preloadRadius:80},
    });
  }
  const boarding=(definition.deckArchitecture?.boarding?.points||[])[0];
  const spawnDeck=decks.find(deck=>deck.id===boarding?.deckId)||decks[0];
  const spawnPoint=boarding?.position?flipPoint(boarding.position):safeDeckPoint(spawnDeck);
  const locationId=`vessel.projection.${safeIdPart(definition.id)}.${safeIdPart(instanceId).replace(/:/g,".")}`;
  return Object.freeze({
    schemaVersion:1,id:locationId,label:String(definition.label||definition.id||"судно"),presentation:{label:String(definition.label||definition.id||"судно"),description:"Совместимая spatial-проекция существующего судна без смены владельца поведения",role:"vehicle"},
    worldTransform:{position:{x:0,y:0,z:0},yaw:0},persistence:{version:1},spaces,connections:projectConnections(decks),
    spawns:[{id:"vessel.spawn.boarding",spaceId:deckSpaceId(spawnDeck.id),position:[spawnPoint.x,spawnPoint.y,0],mode:"foot"}],
    modules:[
      {id:"vessel.navigation",type:"spatial.navigation",config:{}},{id:"vessel.acoustics",type:"spatial.acoustics",config:{}},{id:"vessel.accessibility",type:"spatial.accessibility",config:{}},{id:"vessel.lifecycle",type:"spatial.lifecycle",config:{}},{id:"vessel.replication",type:"spatial.replication",config:{}},{id:"vessel.persistence",type:"spatial.persistence",config:{}},
    ],
    compatibility:[{code:"vessel.spatial-mirror",legacySystem:"vessel.deck-runtime",replacement:"spatial.foundation",targetId:safeIdPart(definition.id),message:"Spatial пока зеркалит палубу; управление и физика остаются у существующего vessel runtime до отдельной миграции власти."}],
    projection:Object.freeze({rootSpaceId:rootId,deckSpaceIds:Object.freeze(Object.fromEntries(decks.map(deck=>[deck.id,deckSpaceId(deck.id)])))}),
  });
}

export function vesselOccupantToSpatialLocal(position={}){return Object.freeze({x:Number(position.x)||0,y:-(Number(position.y)||0),z:0});}
export function vesselDeckSpatialSpaceId(deckId){return deckSpaceId(deckId);}
