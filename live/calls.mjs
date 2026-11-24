import catalog from './catalog.json' with {type:'json'};
export const {aircraft,defects,priorities}=catalog;
export function describe(call){
  if(!call.aircraft)return 'Зона '+call.zone;
  return ['№ '+call.number,call.aircraft,call.tail,'зона '+call.zone,call.description||defects[call.defect]?.join(' · '),call.aog?'AOG':'',call.mel?'MEL '+call.mel:'',priorities[call.priority]].filter(Boolean).join(' · ');
}
